```javascript
import fs from 'fs/promises';
import path from 'path';
import {
    Collection,
    Routes
} from 'discord.js';
import {
    fileURLToPath,
    pathToFileURL
} from 'url';

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

/**
 * Extract slash-command subcommands.
 */
function getSubcommandInfo(commandData) {
    const subcommands = [];
    const options = commandData.options || [];

    for (const option of options) {
        if (option.type === 1) {
            subcommands.push(option.name);
        }

        if (option.type === 2 && Array.isArray(option.options)) {
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

/**
 * Find all JavaScript files recursively.
 */
async function getAllFiles(directory, fileList = []) {
    let entries;

    try {
        entries = await fs.readdir(directory, {
            withFileTypes: true
        });
    } catch (error) {
        if (error.code === 'ENOENT') {
            logger.warn(
                'Command directory does not exist: ' + directory
            );

            return fileList;
        }

        throw error;
    }

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

/**
 * Load command files into client.commands.
 */
export async function loadCommands(client) {
    client.commands = new Collection();

    const commandsPath = path.resolve(
        __dirname,
        '../../commands'
    );

    const commandFiles = await getAllFiles(commandsPath);

    logger.info(
        'Found ' + commandFiles.length + ' command files to load.'
    );

    const uniqueCommandNames = new Set();

    for (const filePath of commandFiles) {
        try {
            const normalizedPath = filePath.replace(/\\/g, '/');

            const commandModule = await import(
                pathToFileURL(filePath).href
            );

            const command =
                commandModule.default || commandModule;

            if (!command.data || !command.execute) {
                logger.warn(
                    'Skipping command without data or execute: ' +
                    normalizedPath
                );

                continue;
            }

            if (
                typeof command.data.name !== 'string' ||
                typeof command.data.toJSON !== 'function'
            ) {
                logger.warn(
                    'Invalid command data in: ' + normalizedPath
                );

                continue;
            }

            const commandName = command.data.name;

            if (uniqueCommandNames.has(commandName)) {
                logger.warn(
                    'Skipping duplicate command: ' + commandName
                );

                continue;
            }

            uniqueCommandNames.add(commandName);

            command.category = path.basename(
                path.dirname(filePath)
            );

            command.filePath = normalizedPath;

            client.commands.set(commandName, command);

            const commandJson = command.data.toJSON();
            const subcommands = getSubcommandInfo(commandJson);

            logger.info(
                'Loaded command: ' + commandName +
                ' from ' + normalizedPath
            );

            if (subcommands.length > 0) {
                logger.info(
                    'Subcommands: ' + subcommands.join(', ')
                );
            }
        } catch (error) {
            logger.error(
                'Failed to load command from ' + filePath,
                error
            );
        }
    }

    logger.info(
        'Successfully loaded ' + client.commands.size + ' commands.'
    );

    return client.commands;
}

/**
 * Prepare commands for Discord API registration.
 */
function collectCommandPayloads(client) {
    const commands = [];
    const registeredNames = new Set();

    let totalSubcommands = 0;

    if (!client.commands) {
        throw new Error(
            'client.commands is missing. Call loadCommands(client) first.'
        );
    }

    for (const command of client.commands.values()) {
        if (
            !command.data ||
            typeof command.data.toJSON !== 'function'
        ) {
            logger.warn(
                'Skipping command with invalid data.'
            );

            continue;
        }

        const commandName = command.data.name;

        if (registeredNames.has(commandName)) {
            logger.warn(
                'Skipping duplicate registration: ' + commandName
            );

            continue;
        }

        registeredNames.add(commandName);

        const commandJson = command.data.toJSON();

        /*
         * Commands with dmEnabled: true can be used in
         * supported DMs and user-installed contexts.
         *
         * Other commands are registered for guild installation.
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
    }

    return {
        commands,
        totalSubcommands
    };
}

/**
 * Validate the number of registered commands.
 */
function validateCommands(commands) {
    if (!Array.isArray(commands)) {
        throw new TypeError(
            'Commands must be provided as an array.'
        );
    }

    if (commands.length > MAX_COMMANDS) {
        throw new Error(
            'Discord allows at most ' + MAX_COMMANDS +
            ' top-level application commands. Found: ' +
            commands.length
        );
    }

    if (commands.length >= COMMAND_COUNT_WARN_THRESHOLD) {
        logger.warn(
            'You are approaching the Discord command limit: ' +
            commands.length + '/' + MAX_COMMANDS
        );
    }

    const names = new Set();

    for (const command of commands) {
        if (!command || typeof command.name !== 'string') {
            throw new Error(
                'A command is missing its name.'
            );
        }

        if (names.has(command.name)) {
            throw new Error(
                'Duplicate command name: ' + command.name
            );
        }

        names.add(command.name);
    }

    return true;
}

/**
 * Prepare and validate the command payload.
 */
export function prepareCommandsForRegistration(client) {
    const result = collectCommandPayloads(client);

    validateCommands(result.commands);

    logger.info(
        'Prepared ' + result.commands.length +
        ' commands and ' + result.totalSubcommands +
        ' subcommands for registration.'
    );

    return result;
}

/**
 * Register global application commands with Discord.
 */
async function registerGlobalCommands(
    client,
    clientId,
    commands,
    totalSubcommands
) {
    const applicationId =
        clientId ||
        client.application?.id ||
        client.user?.id ||
        botConfig.clientId ||
        botConfig.clientID;

    const token =
        botConfig.token ||
        botConfig.discordToken ||
        process.env.DISCORD_TOKEN;

    if (!applicationId) {
        throw new Error(
            'Application ID is missing. Check config/bot.js.'
        );
    }

    if (!token) {
        throw new Error(
            'Discord bot token is missing. Check config/bot.js or DISCORD_TOKEN.'
        );
    }

    validateCommands(commands);

    const rest = client.rest;

    if (!rest || typeof rest.setToken !== 'function') {
        throw new Error(
            'Discord REST client is unavailable. Check your discord.js setup.'
        );
    }

    rest.setToken(token);

    logger.info(
        'Registering ' + commands.length +
        ' global commands with Discord.'
    );

    const registeredCommands = await rest.put(
        Routes.applicationCommands(applicationId),
        {
            body: commands
        }
    );

    logger.info(
        'Successfully registered ' +
        registeredCommands.length +
        ' global commands and ' +
        totalSubcommands +
        ' subcommands.'
    );

    return registeredCommands;
}

/**
 * Public function imported by app.js.
 */
export async function registerCommands(client, options = {}) {
    try {
        const result = prepareCommandsForRegistration(client);

        return await registerGlobalCommands(
            client,
            options.clientId || null,
            result.commands,
            result.totalSubcommands
        );
    } catch (error) {
        logger.error(
            'Error registering application commands:',
            error
        );

        throw error;
    }
}

/**
 * Reload a command by its registered command name.
 */
export async function reloadCommand(client, commandName) {
    if (!client.commands) {
        throw new Error(
            'Commands have not been loaded yet.'
        );
    }

    const existingCommand = client.commands.get(commandName);

    if (!existingCommand) {
        throw new Error(
            'Command not found: ' + commandName
        );
    }

    if (!existingCommand.filePath) {
        throw new Error(
            'Command file path is missing for: ' + commandName
        );
    }

    const fileUrl = pathToFileURL(
        existingCommand.filePath
    );

    fileUrl.searchParams.set(
        'reload',
        String(Date.now())
    );

    const commandModule = await import(fileUrl.href);

    const newCommand =
        commandModule.default || commandModule;

    if (
        !newCommand.data ||
        typeof newCommand.execute !== 'function' ||
        typeof newCommand.data.toJSON !== 'function'
    ) {
        throw new Error(
            'Reloaded command is missing data or execute: ' +
            commandName
        );
    }

    const newCommandName = newCommand.data.name;

    if (
        newCommandName !== commandName &&
        client.commands.has(newCommandName)
    ) {
        throw new Error(
            'Another command already uses the name: ' +
            newCommandName
        );
    }

    newCommand.category = existingCommand.category;
    newCommand.filePath = existingCommand.filePath;

    client.commands.delete(commandName);
    client.commands.set(newCommandName, newCommand);

    logger.info(
        'Successfully reloaded command: ' + newCommandName
    );

    return newCommand;
}
```
