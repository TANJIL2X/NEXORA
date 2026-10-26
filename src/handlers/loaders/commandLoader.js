```js
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { Collection } from 'discord.js';
import { logger } from '../../utils/logger.js';
import botConfig from '../../config/bot.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MAX_COMMANDS = 100;
const COMMAND_COUNT_WARN_THRESHOLD = 90;

// Discord installation types
const GUILD_INSTALL = 0;
const USER_INSTALL = 1;

// Discord command contexts
const GUILD_CONTEXT = 0;
const BOT_DM_CONTEXT = 1;
const PRIVATE_CHANNEL_CONTEXT = 2;

function getSubcommandInfo(commandData) {
    const subcommands = [];

    if (commandData.options) {
        for (const option of commandData.options) {
            if (option.type === 1) {
                subcommands.push(option.name);
            } else if (option.type === 2 && option.options) {
                for (const subOption of option.options) {
                    if (subOption.type === 1) {
                        subcommands.push(
                            `${option.name}/${subOption.name}`
                        );
                    }
                }
            }
        }
    }

    return subcommands;
}

async function getAllFiles(directory, fileList = []) {
    const files = await fs.readdir(directory, {
        withFileTypes: true
    });

    for (const file of files) {
        const filePath = path.join(directory, file.name);

        if (file.isDirectory()) {
            if (file.name === 'modules') {
                continue;
            }

            await getAllFiles(filePath, fileList);
        } else if (file.name.endsWith('.js')) {
            fileList.push(filePath);
        }
    }

    return fileList;
}

export async function loadCommands(client) {
    client.commands = new Collection();

    const commandsPath = path.join(
        __dirname,
        '../../commands'
    );

    const commandFiles = await getAllFiles(commandsPath);

    logger.info(
        `Found ${commandFiles.length} command files to load`
    );

    const uniqueCommandNames = new Set();

    for (const filePath of commandFiles) {
        try {
            const normalizedPath = filePath.replace(/\\/g, '/');
            const commandDir = path.dirname(filePath);
            const category = path.basename(commandDir);

            const commandModule = await import(
                pathToFileURL(filePath).href
            );

            const command = commandModule.default || commandModule;

            if (!command.data || !command.execute) {
                logger.warn(
                    `Command at ${filePath} is missing required data or execute property.`
                );
                continue;
            }

            command.category = category;
            command.filePath = normalizedPath;

            const primaryCommandName = command.data.name;

            if (uniqueCommandNames.has(primaryCommandName)) {
                logger.warn(
                    `Skipping duplicate command: ${primaryCommandName}`
                );
                continue;
            }

            uniqueCommandNames.add(primaryCommandName);
            client.commands.set(primaryCommandName, command);

            const subcommands = getSubcommandInfo(
                command.data.toJSON()
            );

            logger.info(
                `Loaded command: ${primaryCommandName} from ${normalizedPath} (category: ${category})`
            );

            if (subcommands.length > 0) {
                logger.info(
                    `Subcommands: ${subcommands.join(', ')}`
                );
            }
        } catch (error) {
            logger.error(
                `Error loading command from ${filePath}:`,
                error
            );
        }
    }

    logger.info(`Loaded ${client.commands.size} commands`);

    return client.commands;
}

function collectCommandPayloads(client) {
    const commands = [];
    let totalSubcommands = 0;
    const registeredNames = new Set();

    for (const command of client.commands.values()) {
        if (
            !command.data ||
            typeof command.data.toJSON !== 'function'
        ) {
            logger.warn(
                'Command is missing data or toJSON method.'
            );
            continue;
        }

        const commandName = command.data.name;

        if (registeredNames.has(commandName)) {
            logger.warn(
                `Skipping duplicate command: ${commandName}`
            );
            continue;
        }

        registeredNames.add(commandName);

        const commandJson = command.data.toJSON();

        /*
         * By default, commands are available in servers.
         * Add dmEnabled: true to an individual command only
         * when its execute code supports DM usage.
         */

        if (command.dmEnabled === true) {
            commandJson.integration_types = [
                GUILD_INSTALL,
                USER_INSTALL
            ];

            commandJson.contexts = [
                GUILD_CONTEXT,
                BOT_DM_CONTEXT,
                PRIVATE_CHANNEL_CONTEXT
            ];
        } else {
            commandJson.integration_types = [
                GUILD_INSTALL
            ];

            commandJson.contexts = [
                GUILD_CONTEXT
            ];
        }

        commands.push(commandJson);

        totalSubcommands += getSubcommandInfo(
            commandJson
        ).length;

        logger.debug(
            `Prepared command: ${commandName}`
        );
    }

    return {
        commands,
        totalSubcommands
    };
}

function validateCommands(commands) {
    const validationErrors = [];

    for (const cmd of commands) {
        if (cmd.name && cmd.name.length > 32) {
            validationErrors.push(
                `Command ${cmd.name} has a name longer than 32 characters.`
            );
        }

        if (
            cmd.description &&
            cmd.description.length > 100
        ) {
            validationErrors.push(
                `Command ${cmd.name} has a description longer than 100 characters.`
            );
        }

        if (!cmd.options) {
            continue;
        }

        for (const option of cmd.options) {
            if (option.name && option.name.length > 32) {
                validationErrors.push(
                    `Command ${cmd.name}: option ${option.name} has a name longer than 32 characters.`
                );
            }

            if (
                option.description &&
                option.description.length > 100
            ) {
                validationErrors.push(
                    `Command ${cmd.name}: option ${option.name} has a description longer than 100 characters.`
                );
            }
        }
    }

    if (validationErrors.length > 0) {
        logger.error('Command validation failed:');

        for (const error of validationErrors) {
            logger.error(error);
        }

        throw new Error(
            `Command validation failed with ${validationErrors.length} errors.`
        );
    }
}

function prepareCommandsForRegistration(commands) {
    if (commands.length >= COMMAND_COUNT_WARN_THRESHOLD) {
        logger.warn(
            `Command count (${commands.length}) is approaching Discord's global command limit.`
        );
    }

    if (commands.length > MAX_COMMANDS) {
        throw new Error(
            `Found ${commands.length} commands. Discord permits at most ${MAX_COMMANDS} top-level global commands.`
        );
    }

    return commands;
}

async function registerGlobalCommands(
    client,
    clientId,
    commands,
    totalSubcommands
) {
    if (!clientId) {
        throw new Error(
            'CLIENT_ID is required for slash command registration.'
        );
    }

    if (!client.rest) {
        throw new Error(
            'Discord REST client is unavailable.'
        );
    }

    logger.info(
        `Preparing to register ${commands.length} commands and ${totalSubcommands} subcommands.`
    );

    validateCommands(commands);

    const commandsToRegister =
        prepareCommandsForRegistration(commands);

    if (botConfig.commands?.deleteCommands) {
        logger.info('Clearing existing global commands...');

        await client.rest.put(
            `/applications/${clientId}/commands`,
            { body: [] }
        );
    }

    await client.rest.put(
        `/applications/${clientId}/commands`,
        { body: commandsToRegister }
    );

    logger.info(
        `Successfully registered ${commandsToRegister.length} global commands.`
    );
}

export async function registerCommands(client, options = {}) {
    const { clientId = null } = options;

    try {
        const {
            commands,
            totalSubcommands
        } = collectCommandPayloads(client);

        await registerGlobalCommands(
            client,
            clientId,
            commands,
            totalSubcommands
        );
    } catch (error) {
        logger.error('Error registering commands:', error);
        throw error;
    }
}

export async function reloadCommand(client, commandName) {
    const command = client.commands.get(commandName);

    if (!command) {
        return {
            success: false,
            message: `Command "${commandName}" not found`
        };
    }

    try {
        const commandPath = path.resolve(command.filePath);
        const moduleUrl = pathToFileURL(commandPath);

        moduleUrl.searchParams.set(
            't',
            Date.now().toString()
        );

        const module = await import(moduleUrl.href);
        const newCommand = module.default || module;

        if (!newCommand.data || !newCommand.execute) {
            throw new Error(
                'Reloaded command is missing data or execute.'
            );
        }

        newCommand.category = newCommand.category || command.category;
        newCommand.filePath = command.filePath;

        client.commands.set(commandName, newCommand);

        logger.info(`Reloaded command: ${commandName}`);

        return {
            success: true,
            message: `Successfully reloaded command "${commandName}"`
        };
    } catch (error) {
        logger.error(
            `Error reloading command "${commandName}":`,
            error
        );

        return {
            success: false,
            message: `Error reloading command: ${error.message}`
        };
    }
}
```
