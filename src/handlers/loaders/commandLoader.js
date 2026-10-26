```javascript
import fs from 'node:fs/promises';
import path from 'node:path';
import {
    Collection,
    REST,
    Routes
} from 'discord.js';
import {
    fileURLToPath,
    pathToFileURL
} from 'node:url';

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

/**
 * Return slash-command subcommands.
 */
function getSubcommandInfo(commandData) {
    const result = [];
    const options = commandData.options || [];

    for (const option of options) {
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

/**
 * Find JavaScript files recursively.
 */
async function getAllFiles(directory, result = []) {
    let entries;

    try {
        entries = await fs.readdir(directory, {
            withFileTypes: true
        });
    } catch (error) {
        if (error.code === 'ENOENT') {
            logger.warn(
                'Directory not found: ' + directory
            );
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
 * Load commands.
 *
 * IMPORTANT: This named export is required by src/app.js.
 */
export async function loadCommands(client) {
    const commands = new Collection();
    const files = await getAllFiles(COMMANDS_PATH);
    const seenNames = new Set();

    logger.info(
        'Found ' + files.length + ' command files.'
    );

    for (const filePath of files) {
        try {
            const moduleUrl = pathToFileURL(filePath).href;
            const loadedModule = await import(moduleUrl);

            const command =
                loadedModule.default || loadedModule;

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

            if (!name || typeof name !== 'string') {
                logger.warn(
                    'Command has no valid name: ' + filePath
                );
                continue;
            }

            if (seenNames.has(name)) {
                logger.warn(
                    'Duplicate command skipped: ' + name
                );
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
 * Build and validate command registration payload.
 */
export function prepareCommandsForRegistration(client) {
    if (!client.commands) {
        throw new Error(
            'Commands are not loaded. Call loadCommands(client) first.'
        );
    }

    const payload = [];
    const seenNames = new Set();

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

        const json = command.data.toJSON();

        if (!json.name) {
            logger.warn(
                'Skipping command without a name.'
            );
            continue;
        }

        if (seenNames.has(json.name)) {
            logger.warn(
                'Duplicate command skipped: ' + json.name
            );
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
            json.integration_types = [
                GUILD_INSTALL
            ];

            json.contexts = [
                GUILD_CONTEXT
            ];
        }

        payload.push(json);
    }

    if (payload.length > MAX_COMMANDS) {
        throw new Error(
            'Too many top-level commands: ' +
            payload.length +
            '. Discord allows at most ' +
            MAX_COMMANDS + '.'
        );
    }

    return {
        commands: payload,
        totalSubcommands: payload.reduce(
            (total, command) =>
                total + getSubcommandInfo(command).length,
            0
        )
    };
}

/**
 * Register global application commands.
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
            'Application ID is missing. Check config/bot.js.'
        );
    }

    if (!token) {
        throw new Error(
            'Bot token is missing. Check config/bot.js or DISCORD_TOKEN.'
        );
    }

    const {
        commands,
        totalSubcommands
    } = prepareCommandsForRegistration(client);

    const rest = new REST({ version: '10' }).setToken(token);

    logger.info(
        'Registering ' + commands.length +
        ' global slash commands...'
    );

    const registered = await rest.put(
        Routes.applicationCommands(clientId),
        { body: commands }
    );

    logger.info(
        'Registered ' + registered.length +
        ' global commands and ' + totalSubcommands +
        ' subcommands.'
    );

    return registered;
}

/**
 * Reload a previously loaded command.
 */
export async function reloadCommand(client, commandName) {
    if (!client.commands) {
        throw new Error(
            'Commands have not been loaded.'
        );
    }

    const oldCommand = client.commands.get(commandName);

    if (!oldCommand || !oldCommand.filePath) {
        throw new Error(
            'Command not found: ' + commandName
        );
    }

    const url = pathToFileURL(oldCommand.filePath);
    url.searchParams.set('update', String(Date.now()));

    const loadedModule = await import(url.href);
    const command = loadedModule.default || loadedModule;

    if (
        !command.data ||
        typeof command.execute !== 'function' ||
        typeof command.data.toJSON !== 'function'
    ) {
        throw new Error(
            'Reloaded command is invalid: ' + commandName
        );
    }

    command.category = oldCommand.category;
    command.filePath = oldCommand.filePath;

    client.commands.delete(commandName);
    client.commands.set(command.data.name, command);

    logger.info(
        'Reloaded command: ' + command.data.name
    );

    return command;
}
```
