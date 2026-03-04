const logger = require('logplease').create('package');
const semver = require('semver');
const config = require('./config');
const globals = require('./globals');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs/promises');
const fss = require('fs');
const cp = require('child_process');
const crypto = require('crypto');
const runtime = require('./runtime');
const chownr = require('chownr');
const util = require('util');

function parse_nonnegative_int(name, fallback) {
    const raw = process.env[name];

    if (raw === undefined) {
        return fallback;
    }

    const parsed = Number.parseInt(raw, 10);
    return Number.isNaN(parsed) || parsed < 0 ? fallback : parsed;
}

const PACKAGE_DOWNLOAD_TIMEOUT_MS = parse_nonnegative_int(
    'PISTON_PACKAGE_DOWNLOAD_TIMEOUT_MS',
    10 * 60 * 1000
);
const PACKAGE_DOWNLOAD_RETRIES = parse_nonnegative_int(
    'PISTON_PACKAGE_DOWNLOAD_RETRIES',
    2
);
const PACKAGE_DOWNLOAD_RETRY_DELAY_MS = parse_nonnegative_int(
    'PISTON_PACKAGE_DOWNLOAD_RETRY_DELAY_MS',
    2000
);

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

class Package {
    constructor({ language, version, download, checksum }) {
        this.language = language;
        this.version = semver.parse(version);
        this.checksum = checksum;
        this.download = download;
    }

    get installed() {
        return fss.exists_sync(
            path.join(this.install_path, globals.pkg_installed_file)
        );
    }

    get install_path() {
        return path.join(
            config.data_directory,
            globals.data_directories.packages,
            this.language,
            this.version.raw
        );
    }

    async download_package_archive(pkgpath) {
        const download = await fetch(this.download);

        if (!download.ok) {
            throw new Error(
                `Download failed with HTTP ${download.status} ${download.status_text}`
            );
        }

        if (!download.body) {
            throw new Error('Download response did not include a body stream');
        }

        const file_stream = fss.create_write_stream(pkgpath);

        await new Promise((resolve, reject) => {
            let settled = false;

            const timeout = setTimeout(() => {
                const error = new Error(
                    `Download timed out after ${PACKAGE_DOWNLOAD_TIMEOUT_MS}ms`
                );
                download.body.destroy(error);
                file_stream.destroy(error);
            }, PACKAGE_DOWNLOAD_TIMEOUT_MS);

            const finish = callback => error => {
                if (settled) {
                    return;
                }

                settled = true;
                clearTimeout(timeout);
                callback(error);
            };

            const resolve_once = finish(() => resolve());
            const reject_once = finish(error => reject(error));

            file_stream.once('finish', resolve_once);
            file_stream.once('error', reject_once);
            download.body.once('error', reject_once);
            download.body.pipe(file_stream);
        });
    }

    async validate_package_checksum(pkgpath) {
        logger.debug('Validating checksums');
        logger.debug(`Assert sha256(pkg.tar.gz) == ${this.checksum}`);
        const hash = crypto.create_hash('sha256');

        const read_stream = fss.create_read_stream(pkgpath);
        await new Promise((resolve, reject) => {
            read_stream.on('data', chunk => hash.update(chunk));
            read_stream.on('end', resolve);
            read_stream.on('error', reject);
        });

        const cs = hash.digest('hex');

        if (cs !== this.checksum) {
            throw new Error(
                `Checksum miss-match want: ${this.checksum} got: ${cs}`
            );
        }
    }

    async install() {
        if (this.installed) {
            throw new Error('Already installed');
        }

        logger.info(`Installing ${this.language}-${this.version.raw}`);

        try {
            if (fss.exists_sync(this.install_path)) {
                logger.warn(
                    `${this.language}-${this.version.raw} has residual files. Removing them.`
                );
                await fs.rm(this.install_path, { recursive: true, force: true });
            }

            logger.debug(`Making directory ${this.install_path}`);
            await fs.mkdir(this.install_path, { recursive: true });

            logger.debug(
                `Downloading package from ${this.download} in to ${this.install_path}`
            );
            const pkgpath = path.join(this.install_path, 'pkg.tar.gz');
            const attempts = PACKAGE_DOWNLOAD_RETRIES + 1;
            let last_error;

            for (let attempt = 1; attempt <= attempts; attempt++) {
                try {
                    await this.download_package_archive(pkgpath);
                    await this.validate_package_checksum(pkgpath);
                    last_error = undefined;
                    break;
                } catch (error) {
                    last_error = error;
                    await fs.rm(pkgpath, { force: true });

                    if (attempt < attempts) {
                        logger.warn(
                            `Download attempt ${attempt}/${attempts} failed for ${this.language}-${this.version.raw}: ${error.message}`
                        );

                        if (PACKAGE_DOWNLOAD_RETRY_DELAY_MS > 0) {
                            await delay(PACKAGE_DOWNLOAD_RETRY_DELAY_MS);
                        }
                    }
                }
            }

            if (last_error) {
                throw last_error;
            }

            logger.debug(
                `Extracting package files from archive ${pkgpath} in to ${this.install_path}`
            );

            await new Promise((resolve, reject) => {
                const proc = cp.exec(
                    `bash -c 'cd "${this.install_path}" && tar xzf "${pkgpath}"'`
                );

                proc.once('exit', (code, _) => {
                    if (code === 0) {
                        resolve();
                    } else {
                        reject(new Error(`Extraction failed with exit code ${code}`));
                    }
                });

                proc.stdout.pipe(process.stdout);
                proc.stderr.pipe(process.stderr);

                proc.once('error', reject);
            });

            logger.debug('Caching environment');
            const get_env_command = `cd ${this.install_path}; source environment; env`;

            const envout = await new Promise((resolve, reject) => {
                let stdout = '';

                const proc = cp.spawn(
                    'env',
                    ['-i', 'bash', '-c', `${get_env_command}`],
                    {
                        stdio: ['ignore', 'pipe', 'pipe'],
                    }
                );

                proc.once('exit', (code, _) => {
                    if (code === 0) {
                        resolve(stdout);
                    } else {
                        reject(
                            new Error(`Environment capture failed with exit code ${code}`)
                        );
                    }
                });

                proc.stdout.on('data', data => {
                    stdout += data;
                });

                proc.once('error', reject);
            });

            const filtered_env = envout
                .split('\n')
                .filter(
                    l =>
                        !['PWD', 'OLDPWD', '_', 'SHLVL'].includes(
                            l.split('=', 2)[0]
                        )
                )
                .join('\n');

            await fs.write_file(path.join(this.install_path, '.env'), filtered_env);

            logger.debug('Changing Ownership of package directory');
            await util.promisify(chownr)(
                this.install_path,
                process.getuid(),
                process.getgid()
            );

            logger.debug('Writing installed state to disk');
            await fs.write_file(
                path.join(this.install_path, globals.pkg_installed_file),
                Date.now().toString()
            );

            logger.debug('Registering runtime');
            runtime.load_package(this.install_path);

            logger.info(`Installed ${this.language}-${this.version.raw}`);

            return {
                language: this.language,
                version: this.version.raw,
            };
        } catch (error) {
            await fs.rm(this.install_path, { recursive: true, force: true });
            throw error;
        }
    }

    async uninstall() {
        logger.info(`Uninstalling ${this.language}-${this.version.raw}`);

        logger.debug('Finding runtime');
        const found_runtime = runtime.get_runtime_by_name_and_version(
            this.language,
            this.version.raw
        );

        if (!found_runtime) {
            logger.error(
                `Uninstalling ${this.language}-${this.version.raw} failed: Not installed`
            );
            throw new Error(
                `${this.language}-${this.version.raw} is not installed`
            );
        }

        logger.debug('Unregistering runtime');
        found_runtime.unregister();

        logger.debug('Cleaning files from disk');
        await fs.rmdir(this.install_path, { recursive: true });

        logger.info(`Uninstalled ${this.language}-${this.version.raw}`);

        return {
            language: this.language,
            version: this.version.raw,
        };
    }

    static async get_package_list() {
        const repo_content = await fetch(config.repo_url).then(x => x.text());

        const entries = repo_content.split('\n').filter(x => x.length > 0);

        return entries.map(line => {
            const [language, version, checksum, download] = line.split(',', 4);

            return new Package({
                language,
                version,
                checksum,
                download,
            });
        });
    }

    static async get_package(lang, version) {
        const packages = await Package.get_package_list();

        const candidates = packages.filter(pkg => {
            return (
                pkg.language == lang && semver.satisfies(pkg.version, version)
            );
        });

        candidates.sort((a, b) => semver.rcompare(a.version, b.version));

        return candidates[0] || null;
    }
}

module.exports = Package;
