
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Collection, REST, Routes } from 'discord.js';

import { logger } from '../../utils/logger.js';
import botConfig from '../../config/bot.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const COMMANDS_PATH = path.resolve(__dirname, '../../commands');

const MAX_COMMANDS = 100;

const GUILD_INSTALL = 0;
const USER_INSTALL = 1;

const GUILD_CONTEXT = 0;
const BOT_DM_CONTEXT = 1;
const PRIVATE_CHANNEL_CONTEXT = 2;

function getSubcommandInfo(commandData) {
    const result = [];

    for (const option of commandData.options || []) {
        if (option.type === 1) {
            result.push(option.name);
        } else if (
            option.type === 2 &&
            Array.isArray(option.options)
        ) {
            for (const subOption of option.options) {
                if (subOption.type === 1) {
                    result.push(
                        option.name + '/' + subOption.name
                    );
                }
            }
        }
    }

    return result;
}

async function getAllFiles(directory, result = []) {
    let entries;

    try {
        entries = await fs.readdir(directory, {
            withFileTypes: true
        });
    } catch (error) {
        if (error.code === 'ENOENT') {
            logger.warn('Directory not found: ' + directory);
            return result;
        }

        throw error;
    }

    for (const entry of entries) {
        const fullPath = path.join(directory, entry.name);

        if (entry.isDirectory()) {
            if (entry.name === 'modules') {
                continue;
            }

            await getAllFiles(fullPath, result);
        } else if (
            entry.isFile() &&
            entry.name.endsWith('.js')
        ) {
            result.push(fullPath);
        }
    }

    return result;
}

/**
 * Load all command modules.
 */
export async function loadCommands(client) {
    const commands = new Collection();
    const files = await getAllFiles(COMMANDS_PATH);
    const seenNames = new Set();

    logger.info('Found ' + files.length + ' command files.');

    for (const filePath of files) {
        try {
            const imported = await import(
                pathToFileURL(filePath).href
            );

            const command = imported.default || imported;

            if (
                !command.data ||
                typeof command.execute !== 'function' ||
                typeof command.data.toJSON !== 'function'
            ) {
                logger.warn(
                    'Skipping invalid command file: ' + filePath
                );
                continue;
            }

            const name = command.data.name;

            if (typeof name !== 'string' || !name) {
                logger.warn(
                    'Command has an invalid name: ' + filePath
                );
                continue;
            }

            if (seenNames.has(name)) {
                logger.warn('Duplicate command skipped: ' + name);
                continue;
            }

            seenNames.add(name);

            command.category = path.basename(
                path.dirname(filePath)
            );

            command.filePath = filePath.replace(/\\/g, '/');

            commands.set(name, command);

            logger.info('Loaded command: ' + name);
        } catch (error) {
            logger.error(
                'Failed to load command: ' + filePath,
                error
            );
        }
    }

    client.commands = commands;

    logger.info(
        'Loaded ' + commands.size + ' commands successfully.'
    );

    return commands;
}

/**
 * Prepare commands for Discord API registration.
 */
export function prepareCommandsForRegistration(client) {
    if (!client.commands) {
        throw new Error(
            'Commands are not loaded. Call loadCommands(client) first.'
        );
    }

    const commands = [];
    const seenNames = new Set();

    for (const command of client.commands.values()) {
        if (
            !command.data ||
            typeof command.data.toJSON !== 'function'
        ) {
            logger.warn('Skipping command with invalid data.');
            continue;
        }

        const json = command.data.toJSON();

        if (!json.name) {
            logger.warn('Skipping command without a name.');
            continue;
        }

        if (seenNames.has(json.name)) {
            logger.warn('Duplicate command: ' + json.name);
            continue;
        }

        seenNames.add(json.name);

        if (command.dmEnabled === true) {
            json.integration_types = [
                GUILD_INSTALL,
                USER_INSTALL
            ];

            json.contexts = [
                GUILD_CONTEXT,
                BOT_DM_CONTEXT,
                PRIVATE_CHANNEL_CONTEXT
            ];
        } else {
            json.integration_types = [GUILD_INSTALL];
            json.contexts = [GUILD_CONTEXT];
        }

        commands.push(json);
    }

    if (commands.length > MAX_COMMANDS) {
        throw new Error(
            'Discord command limit exceeded: ' +
            commands.length + '/' + MAX_COMMANDS
        );
    }

    const totalSubcommands = commands.reduce(
        (total, command) =>
            total + getSubcommandInfo(command).length,
        0
    );

    return {
        commands,
        totalSubcommands
    };
}

/**
 * Register global slash commands.
 */
export async function registerCommands(client, options = {}) {
    const clientId =
        options.clientId ||
        client.application?.id ||
        client.user?.id ||
        botConfig.clientId ||
        botConfig.clientID;

    const token =
        botConfig.token ||
        botConfig.discordToken ||
        process.env.DISCORD_TOKEN;

    if (!clientId) {
        throw new Error(
            'Application ID is missing in bot configuration.'
        );
    }

    if (!token) {
        throw new Error(
            'Bot token is missing from configuration or DISCORD_TOKEN.'
        );
    }

    const {
        commands,
        totalSubcommands
    } = prepareCommandsForRegistration(client);

    const rest = new REST({ version: '10' }).setToken(token);

    logger.info(
        'Registering ' + commands.length + ' global commands.'
    );

    const registered = await rest.put(
        Routes.applicationCommands(clientId),
        { body: commands }
    );

    logger.info(
        'Registered ' + registered.length +
        ' commands and ' + totalSubcommands + ' subcommands.'
    );

    return registered;
}

/**
 * Reload one command.
 */
export async function reloadCommand(client, commandName) {
    if (!client.commands) {
        throw new Error('Commands have not been loaded.');
    }

    const previous = client.commands.get(commandName);

    if (!previous || !previous.filePath) {
        throw new Error('Command not found: ' + commandName);
    }

    const url = pathToFileURL(previous.filePath);

    url.searchParams.set('reload', String(Date.now()));

    const imported = await import(url.href);
    const command = imported.default || imported;

    if (
        !command.data ||
        typeof command.execute !== 'function' ||
        typeof command.data.toJSON !== 'function'
    ) {
        throw new Error(
            'Reloaded command is invalid: ' + commandName
        );
    }

    command.category = previous.category;
    command.filePath = previous.filePath;

    client.commands.delete(commandName);
    client.commands.set(command.data.name, command);

    logger.info('Reloaded command: ' + command.data.name);

    return command;
}
