#!/usr/bin/env node

require('nocamel');
const path = require('path');
const fs = require('fs/promises');
const Logger = require('logplease');
const config = require('./config');
const globals = require('./globals');
const Package = require('./package');

const logger = Logger.create('auto-install-runtimes');

const DEFAULT_RUNTIME_SPECS = [
    'csharp=6.12.0',
    'python=3.10.0',
    'java=15.0.2',
    'javascript=18.15.0',
    'c++=10.2.0',
    'sqlite3=3.36.0',
    'c=10.2.0',
    'ruby=3.0.1',
    'go=1.16.2',
    'rust=1.68.2',
    'bash=5.2.0',
];

const LANGUAGE_TO_PACKAGE = {
    csharp: 'mono',
    'c#': 'mono',
    javascript: 'node',
    js: 'node',
    'c++': 'gcc',
    cpp: 'gcc',
    c: 'gcc',
    sql: 'sqlite3',
    sqlite: 'sqlite3',
    shellscript: 'bash',
    sh: 'bash',
};

function parse_bool(value, default_value) {
    if (value === undefined) {
        return default_value;
    }

    const normalized = String(value).trim().toLowerCase();

    if (['1', 'true', 'yes', 'on'].includes(normalized)) {
        return true;
    }

    if (['0', 'false', 'no', 'off'].includes(normalized)) {
        return false;
    }

    return default_value;
}

function normalize_language(language) {
    const normalized = language.trim().toLowerCase();
    return LANGUAGE_TO_PACKAGE[normalized] || normalized;
}

function parse_runtime_specs(raw_specs) {
    const unique = new Map();

    for (const entry of raw_specs.split(',')) {
        const spec = entry.trim();

        if (!spec) {
            continue;
        }

        const [raw_language, raw_version] = spec.split('=', 2);
        const language = normalize_language(raw_language || '');
        const version = (raw_version || '*').trim();

        if (!language) {
            throw new Error(`Invalid package selector "${spec}"`);
        }

        const key = `${language}=${version}`;
        unique.set(key, { language, version });
    }

    return Array.from(unique.values());
}

async function ensure_package_installed(language, version) {
    const pkg = await Package.get_package(language, version);

    if (pkg === null) {
        throw new Error(
            `Requested package ${language}-${version} does not exist in the repo index`
        );
    }

    if (pkg.installed) {
        logger.info(`Skipping ${pkg.language}-${pkg.version.raw} (already installed)`);
        return;
    }

    await pkg.install();
}

(async () => {
    const enabled = parse_bool(process.env.PISTON_AUTO_INSTALL_RUNTIMES, true);

    if (!enabled) {
        logger.info('Automatic runtime installation disabled');
        return;
    }

    const raw_specs =
        process.env.PISTON_AUTO_INSTALL_PACKAGES ||
        DEFAULT_RUNTIME_SPECS.join(',');

    const fail_on_error = parse_bool(
        process.env.PISTON_AUTO_INSTALL_FAIL_ON_ERROR,
        true
    );

    const package_dir = path.join(
        config.data_directory,
        globals.data_directories.packages
    );
    await fs.mkdir(package_dir, { recursive: true });

    const packages = parse_runtime_specs(raw_specs);

    logger.info(`Ensuring ${packages.length} runtime packages are installed`);

    const failures = [];

    for (const pkg of packages) {
        try {
            await ensure_package_installed(pkg.language, pkg.version);
        } catch (error) {
            logger.error(
                `Failed to install ${pkg.language}-${pkg.version}: ${error.message}`
            );
            failures.push({
                package: `${pkg.language}-${pkg.version}`,
                message: error.message,
            });
        }
    }

    if (failures.length > 0) {
        logger.error(
            `Automatic runtime installation completed with ${failures.length} failure(s)`
        );

        if (fail_on_error) {
            process.exit(1);
        }
        return;
    }

    logger.info('Automatic runtime installation completed successfully');
})().catch(error => {
    logger.error('Automatic runtime installation failed unexpectedly:', error);
    process.exit(1);
});
