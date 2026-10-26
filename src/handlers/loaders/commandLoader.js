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

const GUILD_INSTALL = 0;
const USER_INSTALL = 1;

const GUILD_CONTEXT = 0;
const BOT_DM_CONTEXT = 1;
const PRIVATE_CHANNEL_CONTEXT = 2;

function getSubcommandInfo(commandData) {
    const subcommands = [];

    if (!Array.isArray(commandData.options)) {
        return subcommands;
    }

    for (const option of commandData.options) {
        if (option.type === 1) {
            subcommands.push(option.name);
        } else if (
            option.type === 2 &&
            Array.isArray(option.options)
        ) {
            for (const subOption of option.options) {
                if (subOption.type === 1) {
                    subcommands.push(
                        option.name + '/' + subOption.name
                    );
                }
            }
        }
    }

    return subcommands;
}

async function getAllFiles(directory, fileList = []) {
    const entries = await fs.readdir(directory, {
        withFileTypes: true
    });

    for (const entry of entries) {
        const filePath = path.join(directory, entry.name);

        if (entry.isDirectory()) {
            if (entry.name === 'modules') {
                continue;
            }

            await getAllFiles(filePath, fileList);
        } else if (
            entry.isFile() &&
            entry.name.endsWith('.js')
        ) {
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
        'Found ' + commandFiles.length + ' command files to load'
    );

    const uniqueNames = new Set();

    for (const filePath of commandFiles) {
        try {
            const normalizedPath = filePath.replace(/\\/g, '/');
            const category = path.basename(path.dirname(filePath));

            const importedModule = await import(
                pathToFileURL(filePath).href
            );

            const command = importedModule.default || importedModule;

            if (
                !command.data ||
                typeof command.data.toJSON !== 'function' ||
                typeof command.execute !== 'function'
            ) {
                logger.warn(
                    'Skipping invalid command file: ' + normalizedPath
                );
                continue;
            }

            const commandJson = command.data.toJSON();
            const commandName = commandJson.name;

            if (!commandName) {
                logger.warn(
                    'Skipping command without a name: ' + normalizedPath
                );
                continue;
            }

            if (uniqueNames.has(commandName)) {
                logger.warn(
                    'Skipping duplicate command: ' + commandName
                );
                continue;
            }

            uniqueNames.add(commandName);

            command.category = category;
            command.filePath = normalizedPath;

            client.commands.set(commandName, command);

            logger.info(
                'Loaded command: ' + commandName +
                ' from ' + normalizedPath +
                ' (category: ' + category + ')'
            );

            const subcommands = getSubcommandInfo(commandJson);

            if (subcommands.length > 0) {
                logger.info(
                    'Subcommands: ' + subcommands.join(', ')
                );
            }
        } catch (error) {
            logger.error(
                'Error loading command from ' + filePath + ':',
                error
            );
        }
    }

    logger.info(
        'Loaded ' + client.commands.size + ' commands'
    );

    return client.commands;
}

function validateOption(option, commandName, errors, parentName = '') {
    const optionName = option.name || '(unnamed)';
    const fullName = parentName
        ? parentName + '/' + optionName
        : optionName;

    if (option.name && option.name.length > 32) {
        errors.push(
            commandName + ': option ' + fullName +
            ' has a name longer than 32 characters.'
        );
    }

    if (
        option.description &&
        option.description.length > 100
    ) {
        errors.push(
            commandName + ': option ' + fullName +
            ' has a description longer than 100 characters.'
        );
    }

    if (Array.isArray(option.options)) {
        for (const childOption of option.options) {
            validateOption(
                childOption,
                commandName,
                errors,
                fullName
            );
        }
    }
}

function validateCommands(commands) {
    const errors = [];
    const names = new Set();

    for (const command of commands) {
        if (!command.name) {
            errors.push('A command is missing its name.');
            continue;
        }

        if (names.has(command.name)) {
            errors.push(
                'Duplicate command name: ' + command.name
            );
        }

        names.add(command.name);

        if (command.name.length > 32) {
            errors.push(
                'Command ' + command.name +
                ' has a name longer than 32 characters.'
            );
        }

        if (
            command.description &&
            command.description.length > 100
        ) {
            errors.push(
                'Command ' + command.name +
                ' has a description longer than 100 characters.'
            );
        }

        if (Array.isArray(command.options)) {
            for (const option of command.options) {
                validateOption(
                    option,
                    command.name,
                    errors
                );
            }
        }
    }

    if (errors.length > 0) {
        logger.error('Command validation failed:');

        for (const error of errors) {
            logger.error(error);
        }

        throw new Error(
            'Command validation failed with ' +
            errors.length + ' error(s).'
        );
    }
}

function collectCommandPayloads(client) {
    const commands = [];
    const registeredNames = new Set();
    let totalSubcommands = 0;

    for (const command of client.commands.values()) {
        if (
            !command.data ||
            typeof command.data.toJSON !== 'function'
        ) {
            logger.warn(
                'Skipping command without a valid data builder.'
            );
            continue;
        }

        const commandJson = command.data.toJSON();
        const commandName = commandJson.name;

        if (registeredNames.has(commandName)) {
            logger.warn(
                'Skipping duplicate command: ' + commandName
            );
            continue;
        }

        registeredNames.add(commandName);

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
            'Prepared command: ' + commandName
        );
    }

    return {
        commands,
        totalSubcommands
    };
}

function prepareCommandsForRegistration(commands) {
    if (commands.length >= COMMAND_COUNT_WARN_THRESHOLD) {
        logger.warn(
            'Command count (' + commands.length +
            ') is approaching Discord global command limit.'
        );
    }

    if (commands.length > MAX_COMMANDS) {
        throw new Error(
            'Found ' + commands.length +
            ' commands. Discord permits at most ' +
            MAX_COMMANDS + ' top-level global commands.'
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
        'Preparing to register ' + commands.length +
        ' commands and ' + totalSubcommands + ' subcommands.'
    );

    validateCommands(commands);

    const commandsToRegister =
        prepareCommandsForRegistration(commands);

    if (botConfig.commands && botConfig.commands.deleteCommands === true) {
        logger.info('Clearing existing global commands...');

        await client.rest.put(
            '/applications/' + clientId + '/commands',
            { body: [] }
        );
    }

    await client.rest.put(
        '/applications/' + clientId + '/commands',
        { body: commandsToRegister }
    );

    logger.info(
        'Successfully registered ' +
        commandsToRegister.length + ' global commands.'
    );
}

export async function registerCommands(client, options = {}) {
    const clientId = options.clientId || (
        client.application ? client.application.id : null
    );

    try {
        const result = collectCommandPayloads(client);

        await registerGlobalCommands(
            client,
            clientId,
            result.commands,
            result.totalSubcommands
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
            message: 'Command "' + commandName + '" not found'
        };
    }

    try {
        const commandPath = path.resolve(command.filePath);
        const moduleUrl = pathToFileURL(commandPath);

        moduleUrl.searchParams.set(
            't',
            Date.now().toString()
        );

        const importedModule = await import(moduleUrl.href);
        const newCommand = importedModule.default || importedModule;

        if (
            !newCommand.data ||
            typeof newCommand.data.toJSON !== 'function' ||
            typeof newCommand.execute !== 'function'
        ) {
            throw new Error(
                'Reloaded command is missing valid data or execute properties.'
            );
        }

        const newName = newCommand.data.toJSON().name;

        if (
            newName !== commandName &&
            client.commands.has(newName)
        ) {
            throw new Error(
                'Another command already uses the name "' +
                newName + '".'
            );
        }

        newCommand.category =
            newCommand.category || command.category;

        newCommand.filePath = command.filePath;

        client.commands.delete(commandName);
        client.commands.set(newName, newCommand);

        logger.info('Reloaded command: ' + newName);

        return {
            success: true,
            message: 'Successfully reloaded command "' + newName + '"'
        };
    } catch (error) {
        logger.error(
            'Error reloading command "' + commandName + '":',
            error
        );

        return {
            success: false,
            message: 'Error reloading command: ' + error.message
        };
    }
}
```
