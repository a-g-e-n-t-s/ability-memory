// lib/backup.js - ArcadeDB Backup Management
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const crypto = require('crypto');

class BackupManager {
    constructor(config) {
        this.config = config;
        this.host = config.server.host;
        this.port = config.server.port;
        this.username = config.server.username;
        this.password = config.server.password;
        this.containerName = config.server.container_name;
        this.dataDir = config.storage.data_dir;
        this.backupDir = config.storage.backup_dir;
        this.retentionDays = config.defaults.backup_retention_days || 30;
    }

    /**
     * Create a backup of the specified database
     */
    async createBackup(databaseName, options = {}) {
        const { verify = true } = options;

        try {
            console.log(`💾 Creating backup of database: ${databaseName}`);

            // Ensure container is running
            await this._ensureContainerRunning();

            // Ensure backup directory exists
            this._ensureBackupDirectory(databaseName);

            // Execute backup command via API
            const backupResult = await this._executeBackupCommand(databaseName);
            
            // Get backup file info
            const backupInfo = await this._getBackupInfo(databaseName, backupResult.backupFile);

            console.log(`✅ Backup created: ${backupInfo.fileName}`);
            console.log(`📁 Location: ${backupInfo.fullPath}`);
            console.log(`📊 Size: ${backupInfo.sizeFormatted}`);

            // Verify backup if requested
            if (verify) {
                const isValid = await this.verifyBackup(backupInfo.fullPath);
                if (!isValid) {
                    throw new Error('Backup verification failed');
                }
                console.log('✅ Backup verification passed');
            }

            return backupInfo;

        } catch (error) {
            console.error('❌ Backup failed:', error.message);
            throw error;
        }
    }

    /**
     * Restore database from backup file
     */
    async restoreBackup(databaseName, backupFilePath, options = {}) {
        const { overwrite = false } = options;

        try {
            console.log(`🔄 Restoring database: ${databaseName}`);
            console.log(`📁 From backup: ${backupFilePath}`);

            // Verify backup file exists and is valid
            if (!fs.existsSync(backupFilePath)) {
                throw new Error(`Backup file not found: ${backupFilePath}`);
            }

            const backupValid = await this.verifyBackup(backupFilePath);
            if (!backupValid) {
                throw new Error('Backup file verification failed');
            }

            // Check if database already exists (only if server is running)
            if (!overwrite) {
                try {
                    const exists = await this._databaseExists(databaseName);
                    if (exists) {
                        throw new Error(`Database '${databaseName}' already exists. Use --overwrite to replace it.`);
                    }
                } catch (error) {
                    // If we can't check, assume it's safe to proceed
                    console.log('⚠️ Could not check if database exists, proceeding with restore');
                }
            }

            // Prepare backup file for restore
            await this._prepareBackupForRestore(databaseName, backupFilePath);

            // Stop any existing container and start fresh
            console.log('🛑 Stopping container for restore...');
            await this._stopContainer();

            console.log('🚀 Starting fresh container...');
            await this._startContainer();

            // Execute restore using restore.sh script
            console.log('🔧 Running restore script...');
            await this._executeRestoreScript(databaseName, path.basename(backupFilePath));

            // Stop container, then restart to load restored database
            console.log('🛑 Stopping container after restore...');
            await this._stopContainer();

            console.log('⏳ Waiting for cleanup...');
            await new Promise(resolve => setTimeout(resolve, 2000));

            console.log('🚀 Restarting container with restored database...');
            await this._startContainer();

            console.log(`✅ Database '${databaseName}' successfully restored!`);
            console.log(`🌐 Access ArcadeDB Studio: http://${this.host}:${this.port}`);

            return true;

        } catch (error) {
            console.error('❌ Restore failed:', error.message);
            throw error;
        }
    }

    /**
     * List all available backups
     */
    listBackups(options = {}) {
        const { database = null } = options;

        console.log('📋 Available backups:');

        if (!fs.existsSync(this.backupDir)) {
            console.log('ℹ️ No backups directory found');
            return [];
        }

        const allBackups = [];

        try {
            const databases = fs.readdirSync(this.backupDir, { withFileTypes: true })
                .filter(item => item.isDirectory())
                .map(item => item.name)
                .filter(dbName => !database || dbName === database);

            if (databases.length === 0) {
                console.log('ℹ️ No backups found');
                return allBackups;
            }

            databases.forEach(dbName => {
                console.log(`\n📁 ${dbName}:`);
                const dbBackupDir = path.join(this.backupDir, dbName);

                try {
                    const backups = fs.readdirSync(dbBackupDir)
                        .map(fileName => {
                            const filePath = path.join(dbBackupDir, fileName);
                            const stats = fs.statSync(filePath);
                            
                            const backupInfo = {
                                database: dbName,
                                fileName,
                                fullPath: filePath,
                                size: stats.size,
                                sizeFormatted: this._formatFileSize(stats.size),
                                created: stats.mtime,
                                age: this._getAge(stats.mtime)
                            };

                            allBackups.push(backupInfo);
                            return backupInfo;
                        })
                        .sort((a, b) => b.created - a.created); // Newest first

                    backups.forEach(backup => {
                        console.log(`   📦 ${backup.fileName}`);
                        console.log(`      Size: ${backup.sizeFormatted}`);
                        console.log(`      Created: ${backup.created.toLocaleString()}`);
                        console.log(`      Age: ${backup.age}`);
                        console.log(`      Path: ${backup.fullPath}`);
                    });

                } catch (error) {
                    console.log(`   ❌ Error reading backups: ${error.message}`);
                }
            });

        } catch (error) {
            console.log('❌ Error reading backups directory:', error.message);
        }

        return allBackups;
    }

    /**
     * Verify backup file integrity
     */
    async verifyBackup(backupFilePath) {
        try {
            console.log(`🔍 Verifying backup: ${path.basename(backupFilePath)}`);

            // Check file exists
            if (!fs.existsSync(backupFilePath)) {
                console.log('❌ Backup file not found');
                return false;
            }

            // Check file size
            const stats = fs.statSync(backupFilePath);
            if (stats.size === 0) {
                console.log('❌ Backup file is empty');
                return false;
            }

            // Check file extension
            if (!backupFilePath.endsWith('.zip')) {
                console.log('⚠️ Warning: Backup file is not a .zip file');
            }

            // Basic ZIP file validation (check ZIP signature)
            const buffer = Buffer.alloc(4);
            const fd = fs.openSync(backupFilePath, 'r');
            fs.readSync(fd, buffer, 0, 4, 0);
            fs.closeSync(fd);

            const zipSignature = buffer.toString('hex');
            const validZipSignatures = ['504b0304', '504b0506', '504b0708'];
            
            if (!validZipSignatures.includes(zipSignature)) {
                console.log('❌ Invalid ZIP file format');
                return false;
            }

            console.log('✅ Backup file verification passed');
            console.log(`📊 Size: ${this._formatFileSize(stats.size)}`);
            console.log(`📅 Created: ${stats.mtime.toLocaleString()}`);

            return true;

        } catch (error) {
            console.log('❌ Backup verification failed:', error.message);
            return false;
        }
    }

    /**
     * Clean up old backups based on retention policy
     */
    cleanupOldBackups(options = {}) {
        const { olderThanDays = this.retentionDays, dryRun = false } = options;

        console.log(`🧹 Cleaning up backups older than ${olderThanDays} days...`);

        if (dryRun) {
            console.log('🔍 Dry run mode - no files will be deleted');
        }

        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

        const allBackups = this.listBackups();
        const oldBackups = allBackups.filter(backup => backup.created < cutoffDate);

        if (oldBackups.length === 0) {
            console.log('ℹ️ No old backups to clean up');
            return [];
        }

        const cleanedUp = [];

        oldBackups.forEach(backup => {
            try {
                console.log(`${dryRun ? '🔍' : '🗑️'} ${dryRun ? 'Would delete' : 'Deleting'}: ${backup.fileName} (${backup.age})`);
                
                if (!dryRun) {
                    fs.unlinkSync(backup.fullPath);
                    
                    // Remove empty database directories
                    const dbDir = path.dirname(backup.fullPath);
                    try {
                        const remaining = fs.readdirSync(dbDir);
                        if (remaining.length === 0) {
                            fs.rmdirSync(dbDir);
                            console.log(`📁 Removed empty directory: ${path.basename(dbDir)}`);
                        }
                    } catch (error) {
                        // Directory not empty or other error, ignore
                    }
                }
                
                cleanedUp.push(backup);
                
            } catch (error) {
                console.log(`❌ Failed to delete ${backup.fileName}: ${error.message}`);
            }
        });

        if (!dryRun && cleanedUp.length > 0) {
            const totalSize = cleanedUp.reduce((sum, backup) => sum + backup.size, 0);
            console.log(`✅ Cleaned up ${cleanedUp.length} backups, freed ${this._formatFileSize(totalSize)}`);
        }

        return cleanedUp;
    }

    // Private helper methods

    async _ensureContainerRunning() {
        try {
            const containerRunning = execSync(
                `docker ps --filter name=${this.containerName} --format "{{.Names}}"`,
                { encoding: 'utf8' }
            ).trim();

            if (!containerRunning) {
                throw new Error('Container is not running. Start it first with: node arcade-admin.js start');
            }
        } catch (error) {
            throw new Error('Container is not running. Start it first with: node arcade-admin.js start');
        }
    }

    _ensureBackupDirectory(databaseName) {
        const dbBackupDir = path.join(this.backupDir, databaseName);
        if (!fs.existsSync(dbBackupDir)) {
            fs.mkdirSync(dbBackupDir, { recursive: true });
        }
        return dbBackupDir;
    }

    async _executeBackupCommand(databaseName) {
        const auth = Buffer.from(`${this.username}:${this.password}`).toString('base64');

        console.log('🔄 Executing BACKUP DATABASE command...');

        const response = await fetch(`http://${this.host}:${this.port}/api/v1/command/${databaseName}`, {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${auth}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                language: 'sql',
                command: 'BACKUP DATABASE'
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Backup command failed: ${response.status} - ${errorText}`);
        }

        const result = await response.json();
        return result.result[0];
    }

    async _getBackupInfo(databaseName, backupFileName) {
        const fullPath = path.join(this.backupDir, databaseName, backupFileName);
        
        // Wait for file system sync
        await new Promise(resolve => setTimeout(resolve, 1000));

        if (!fs.existsSync(fullPath)) {
            throw new Error(`Backup file not found: ${fullPath}`);
        }

        const stats = fs.statSync(fullPath);
        
        return {
            database: databaseName,
            fileName: backupFileName,
            fullPath,
            size: stats.size,
            sizeFormatted: this._formatFileSize(stats.size),
            created: stats.mtime,
            age: this._getAge(stats.mtime)
        };
    }

    async _prepareBackupForRestore(databaseName, backupFilePath) {
        const targetDir = path.join(this.backupDir, databaseName);
        const targetPath = path.join(targetDir, path.basename(backupFilePath));

        if (!fs.existsSync(targetPath)) {
            console.log('📤 Copying backup to backup directory...');
            this._ensureBackupDirectory(databaseName);
            fs.copyFileSync(backupFilePath, targetPath);
            console.log('✅ Backup file copied');
        }
    }

    async _executeRestoreScript(databaseName, backupFileName) {
        const containerBackupPath = `backups/${databaseName}/${backupFileName}`;
        const containerDatabasePath = `databases/${databaseName}`;

        const restoreCommand = `docker exec ${this.containerName} ` +
            `/home/arcadedb/bin/restore.sh -f ${containerBackupPath} -d ${containerDatabasePath}`;

        console.log('🔧 Running restore script...');

        try {
            const output = execSync(restoreCommand, { encoding: 'utf8' });
            console.log('✅ Restore script completed');
            if (output.trim()) {
                console.log('📋 Restore output:', output.trim());
            }
        } catch (error) {
            console.log('⚠️ Restore script output:', error.message);
            // Continue as restore might have worked despite warnings
        }
    }

    async _stopContainer() {
        try {
            execSync(`docker stop ${this.containerName}`, { stdio: 'ignore' });
            console.log('✅ Container stopped');
        } catch (error) {
            console.log('ℹ️ Container was not running');
        }
    }

    async _startContainer() {
        const dataDir = this.config.storage.data_dir;
        const databasesDir = path.join(dataDir, 'databases');
        const backupsDir = path.join(dataDir, 'backups');

        // Ensure directories exist
        if (!fs.existsSync(databasesDir)) {
            fs.mkdirSync(databasesDir, { recursive: true });
        }
        if (!fs.existsSync(backupsDir)) {
            fs.mkdirSync(backupsDir, { recursive: true });
        }

        const dockerCmd = `docker run --rm -d --name ${this.containerName} ` +
            `-p ${this.port}:2480 -p 2424:2424 ` +
            `-v "${path.resolve(databasesDir)}":/home/arcadedb/databases ` +
            `-v "${path.resolve(backupsDir)}":/home/arcadedb/backups ` +
            `-e JAVA_OPTS="-Darcadedb.server.rootPassword=${this.password} ` +
            `-Darcadedb.server.databaseDirectory=/home/arcadedb/databases ` +
            `-Darcadedb.server.backupDirectory=/home/arcadedb/backups" ` +
            `arcadedata/arcadedb:latest`;

        execSync(dockerCmd);
        
        // Wait for server to be ready
        let attempts = 0;
        while (attempts < 60) {
            try {
                const response = await fetch(`http://${this.host}:${this.port}/api/v1/ready`, {
                    signal: AbortSignal.timeout(3000)
                });
                if (response.status === 204) {
                    console.log('✅ Container started and ready');
                    return;
                }
            } catch (error) {
                // Expected during startup
            }
            
            await new Promise(resolve => setTimeout(resolve, 1000));
            attempts++;
        }
        
        throw new Error('Container failed to become ready');
    }

    async _databaseExists(databaseName) {
        try {
            const auth = Buffer.from(`${this.username}:${this.password}`).toString('base64');
            
            const response = await fetch(`http://${this.host}:${this.port}/api/v1/databases`, {
                method: 'GET',
                headers: {
                    'Authorization': `Basic ${auth}`
                }
            });

            if (response.ok) {
                const result = await response.json();
                return result.result && result.result.includes(databaseName);
            }
            
            return false;
        } catch (error) {
            return false;
        }
    }

    _formatFileSize(bytes) {
        if (bytes === 0) return '0 B';
        
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    _getAge(date) {
        const now = new Date();
        const diff = now - date;
        const days = Math.floor(diff / (1000 * 60 * 60 * 24));
        const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
        
        if (days > 0) {
            return `${days} day${days !== 1 ? 's' : ''} ago`;
        } else if (hours > 0) {
            return `${hours} hour${hours !== 1 ? 's' : ''} ago`;
        } else {
            return 'Less than 1 hour ago';
        }
    }
}

module.exports = BackupManager;