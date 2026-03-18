#!/usr/bin/env node

// arcade-admin.js - Main CLI Entry Point for ArcadeDB Admin Tool
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

// Import lib modules
const ContainerManager = require('./lib/container.cjs');
const DatabaseManager = require('./lib/database.cjs');
const BackupManager = require('./lib/backup.cjs');
const ImportExportManager = require('./lib/import-export.cjs');
const MonitoringManager = require('./lib/monitoring.cjs');

class ArcadeAdmin {
    constructor() {
        this.config = this.loadConfig();
        this.containerManager = new ContainerManager(this.config);
        this.databaseManager = new DatabaseManager(this.config);
        this.backupManager = new BackupManager(this.config);
        this.importExportManager = new ImportExportManager(this.config);
        this.monitoringManager = new MonitoringManager(this.config);
    }

    loadConfig() {
        const configPath = path.join(__dirname, 'config.yml');
        
        // Default configuration
        const defaultConfig = {
            server: {
                host: 'localhost',
                port: 2480,
                container_name: 'arcadeDB',
                username: 'root',
                password: 'playwithdata'
            },
            storage: {
                data_dir: './arcadedb-data',
                backup_dir: './arcadedb-data/backups'
            },
            defaults: {
                backup_retention_days: 30,
                log_lines: 50
            }
        };

        // Load from config file if it exists
        if (fs.existsSync(configPath)) {
            try {
                const configContent = fs.readFileSync(configPath, 'utf8');
                const fileConfig = yaml.load(configContent);
                return { ...defaultConfig, ...fileConfig };
            } catch (error) {
                console.warn(`⚠️ Could not load config file: ${error.message}`);
                console.log('ℹ️ Using default configuration');
            }
        }

        return defaultConfig;
    }

    async run() {
        const args = process.argv.slice(2);
        
        if (args.length === 0) {
            this.showHelp();
            return;
        }

        const command = args[0];
        const subcommand = args[1];
        
        // Handle different command argument patterns
        let options;
        switch (command) {
            case 'database':
            case 'config':
                // These have subcommands: command subcommand [args] [options]
                options = this.parseOptions(args.slice(2));
                break;
            case 'backup':
            case 'import':
            case 'export':
                // These take: command arg1 [args] [options]
                options = this.parseOptions(args.slice(2));
                break;
            case 'restore':
            case 'verify-backup':
                // These take: command arg1 arg2 [options]
                options = this.parseOptions(args.slice(3));
                break;
            default:
                // Simple commands: command [options]
                options = this.parseOptions(args.slice(1));
                break;
        }

        try {
            switch (command) {
                case 'start':
                    await this.handleStart(options);
                    break;
                
                case 'stop':
                    await this.handleStop(options);
                    break;
                
                case 'restart':
                    await this.handleRestart(options);
                    break;
                
                case 'status':
                    await this.handleStatus();
                    break;
                
                case 'database':
                    await this.handleDatabase(subcommand, options);
                    break;
                
                case 'backup':
                    await this.handleBackup(subcommand, options);
                    break;
                
                case 'restore':
                    const backupFile = args[2]; // Third argument is the backup file
                    await this.handleRestore(subcommand, backupFile, options);
                    break;
                
                case 'list-backups':
                    await this.handleListBackups(options);
                    break;
                
                case 'verify-backup':
                    await this.handleVerifyBackup(subcommand);
                    break;
                
                case 'import':
                    await this.handleImport(subcommand, options);
                    break;
                
                case 'export':
                    await this.handleExport(subcommand, options);
                    break;
                
                case 'health':
                    await this.handleHealth();
                    break;
                
                case 'logs':
                    await this.handleLogs(options);
                    break;
                
                case 'metrics':
                    await this.handleMetrics();
                    break;
                
                case 'monitor':
                    await this.handleMonitor(options);
                    break;
                
                case 'diagnostics':
                    await this.handleDiagnostics();
                    break;
                
                case 'optimize':
                    await this.handleOptimize(subcommand);
                    break;
                
                case 'cleanup':
                    await this.handleCleanup(options);
                    break;
                
                case 'clear-databases':
                    await this.handleClearDatabases(options);
                    break;
                
                case 'clean-all':
                    await this.handleCleanAll(options);
                    break;
                
                case 'config':
                    await this.handleConfig(subcommand, options);
                    break;
                
                case 'help':
                case '--help':
                case '-h':
                    this.showHelp();
                    break;
                
                case 'version':
                case '--version':
                case '-v':
                    this.showVersion();
                    break;
                
                default:
                    console.log(`❌ Unknown command: ${command}`);
                    console.log('Use "help" to see available commands');
                    process.exit(1);
            }
        } catch (error) {
            console.error(`❌ Command failed: ${error.message}`);
            process.exit(1);
        }
    }

    // Command handlers

    async handleStart(options) {
        const withTestData = options.includes('--with-test-data');
        const restart = options.includes('--restart');
        
        await this.containerManager.start({ 
            withTestData, 
            restart 
        });
    }

    async handleStop(options) {
        const force = options.includes('--force');
        await this.containerManager.stop({ force });
    }

    async handleRestart(options) {
        const withTestData = options.includes('--with-test-data');
        await this.containerManager.restart({ withTestData });
    }

    async handleStatus() {
        const status = await this.containerManager.getStatus();
        
        console.log('📊 ArcadeDB System Status');
        console.log('═'.repeat(40));
        
        // Container status
        console.log(`🐳 Container: ${status.container.running ? '✅ Running' : '❌ Stopped'}`);
        if (status.container.running) {
            console.log(`   Status: ${status.container.status}`);
            if (status.container.uptime) {
                console.log(`   Uptime: ${status.container.uptime}`);
            }
        }
        
        // Server status
        console.log(`🌐 Server: ${status.server.ready ? '✅ Ready' : status.server.accessible ? '⚠️ Starting' : '❌ Not accessible'}`);
        
        // Storage status
        console.log(`💾 Data Directory: ${status.storage.exists ? '✅ Exists' : '❌ Missing'}`);
        console.log(`   Path: ${status.storage.dataDir}`);
        
        if (status.server.ready) {
            try {
                const databases = await this.databaseManager.listDatabases();
                console.log(`📋 Databases: ${databases.length}`);
            } catch (error) {
                console.log('📋 Databases: Could not retrieve');
            }
        }
    }

    async handleDatabase(subcommand, options) {
        if (!subcommand) {
            console.log('❌ Database subcommand required');
            console.log('Available: list, create, drop, info, users');
            return;
        }

        switch (subcommand) {
            case 'list':
                await this.databaseManager.listDatabases();
                break;
            
            case 'create':
                const createName = options.find(opt => !opt.startsWith('--'));
                if (!createName) {
                    console.log('❌ Database name required');
                    return;
                }
                const schemaFile = this.getOptionValue(options, '--schema');
                await this.databaseManager.createDatabase(createName, { schema: schemaFile });
                break;
            
            case 'drop':
                const dropName = options.find(opt => !opt.startsWith('--'));
                if (!dropName) {
                    console.log('❌ Database name required');
                    return;
                }
                const confirm = options.includes('--confirm');
                await this.databaseManager.dropDatabase(dropName, { confirm });
                break;
            
            case 'info':
                const infoName = options.find(opt => !opt.startsWith('--'));
                if (!infoName) {
                    console.log('❌ Database name required');
                    return;
                }
                await this.databaseManager.getDatabaseInfo(infoName);
                break;
            
            case 'users':
                const usersName = options.find(opt => !opt.startsWith('--'));
                if (!usersName) {
                    console.log('❌ Database name required');
                    return;
                }
                await this.databaseManager.getDatabaseUsers(usersName);
                break;
            
            case 'stats':
                await this.databaseManager.getDatabaseStats();
                break;
            
            default:
                console.log(`❌ Unknown database subcommand: ${subcommand}`);
        }
    }

    async handleBackup(databaseName, options) {
        if (!databaseName) {
            console.log('❌ Database name required');
            return;
        }
        
        const verify = !options.includes('--no-verify');
        await this.backupManager.createBackup(databaseName, { verify });
    }

    async handleRestore(databaseName, backupFile, options) {
        if (!databaseName) {
            console.log('❌ Database name required');
            return;
        }
        
        if (!backupFile) {
            console.log('❌ Backup file path required');
            return;
        }
        
        const overwrite = options.includes('--overwrite');
        await this.backupManager.restoreBackup(databaseName, backupFile, { overwrite });
    }

    async handleListBackups(options) {
        const database = this.getOptionValue(options, '--database');
        this.backupManager.listBackups({ database });
    }

    async handleVerifyBackup(backupFile) {
        if (!backupFile) {
            console.log('❌ Backup file path required');
            return;
        }
        
        const isValid = await this.backupManager.verifyBackup(backupFile);
        if (isValid) {
            console.log('✅ Backup verification passed');
        } else {
            console.log('❌ Backup verification failed');
            process.exit(1);
        }
    }

    async handleImport(databaseName, options) {
        if (!databaseName) {
            console.log('❌ Database name required');
            return;
        }
        
        const filePath = options.find(opt => !opt.startsWith('--'));
        if (!filePath) {
            console.log('❌ Import file path required');
            return;
        }
        
        const format = this.getOptionValue(options, '--format');
        const type = this.getOptionValue(options, '--type');
        const createType = !options.includes('--no-create-type');
        const batchSize = parseInt(this.getOptionValue(options, '--batch-size')) || 1000;
        
        await this.importExportManager.importData(databaseName, filePath, {
            format,
            type,
            createType,
            batchSize
        });
    }

    async handleExport(databaseName, options) {
        if (!databaseName) {
            console.log('❌ Database name required');
            return;
        }
        
        const outputPath = options.find(opt => !opt.startsWith('--'));
        if (!outputPath) {
            console.log('❌ Output file path required');
            return;
        }
        
        const format = this.getOptionValue(options, '--format');
        const query = this.getOptionValue(options, '--query');
        const type = this.getOptionValue(options, '--type');
        const includeEdges = options.includes('--include-edges');
        
        await this.importExportManager.exportData(databaseName, outputPath, {
            format,
            query,
            type,
            includeEdges
        });
    }

    async handleHealth() {
        await this.monitoringManager.performHealthCheck();
    }

    async handleLogs(options) {
        const lines = parseInt(this.getOptionValue(options, '--lines')) || this.config.defaults.log_lines;
        const since = this.getOptionValue(options, '--since');
        const level = this.getOptionValue(options, '--level');
        
        await this.monitoringManager.getLogs({ lines, since, level });
    }

    async handleMetrics() {
        await this.monitoringManager.getMetrics();
    }

    async handleMonitor(options) {
        const duration = parseInt(this.getOptionValue(options, '--duration')) || 60;
        const interval = parseInt(this.getOptionValue(options, '--interval')) || 10;
        
        await this.monitoringManager.monitorSystem({ duration, interval });
    }

    async handleDiagnostics() {
        await this.monitoringManager.runDiagnostics();
    }

    async handleOptimize(databaseName) {
        if (!databaseName) {
            console.log('❌ Database name required');
            return;
        }
        
        console.log(`🔧 Optimizing database: ${databaseName}`);
        console.log('ℹ️ This feature will be implemented in a future version');
        // TODO: Implement database optimization
    }

    async handleCleanup(options) {
        const dryRun = options.includes('--dry-run');
        const olderThanDays = parseInt(this.getOptionValue(options, '--older-than')) || this.config.defaults.backup_retention_days;
        
        console.log('🧹 Performing cleanup operations...');
        
        // Clean old backups
        console.log('\n📦 Cleaning old backups...');
        this.backupManager.cleanupOldBackups({ olderThanDays, dryRun });
        
        // Clean container resources
        console.log('\n🐳 Cleaning Docker resources...');
        if (!dryRun) {
            this.containerManager.cleanup();
        } else {
            console.log('🔍 Dry run mode - Docker cleanup would be performed');
        }
        
        console.log('\n✅ Cleanup completed');
    }

    async handleClearDatabases(options) {
        const confirm = options.includes('--confirm');
        
        if (!confirm) {
            console.log('⚠️ This will remove all databases but keep backups');
            console.log('⚠️ Use --confirm flag to proceed');
            return;
        }
        
        console.log('🗑️ Clearing all databases...');
        
        try {
            await this.containerManager.stop();
            
            const databasesDir = path.join(this.config.storage.data_dir, 'databases');
            if (fs.existsSync(databasesDir)) {
                const databases = fs.readdirSync(databasesDir, { withFileTypes: true })
                    .filter(item => item.isDirectory());
                
                databases.forEach(db => {
                    const dbPath = path.join(databasesDir, db.name);
                    fs.rmSync(dbPath, { recursive: true, force: true });
                    console.log(`✅ Removed database: ${db.name}`);
                });
                
                console.log(`✅ Cleared ${databases.length} databases`);
            } else {
                console.log('ℹ️ No databases directory found');
            }
            
            console.log('💾 Backups preserved');
            
        } catch (error) {
            console.error('❌ Failed to clear databases:', error.message);
            throw error;
        }
    }

    async handleCleanAll(options) {
        const confirm = options.includes('--confirm');
        
        if (!confirm) {
            console.log('⚠️ This will remove ALL data including backups');
            console.log('⚠️ Use --confirm flag to proceed');
            return;
        }
        
        console.log('🧹 Cleaning all data...');
        
        try {
            await this.containerManager.stop();
            
            if (fs.existsSync(this.config.storage.data_dir)) {
                fs.rmSync(this.config.storage.data_dir, { recursive: true, force: true });
                console.log('✅ All data removed');
            } else {
                console.log('ℹ️ No data directory to remove');
            }
            
        } catch (error) {
            console.error('❌ Failed to clean all data:', error.message);
            throw error;
        }
    }

    async handleConfig(subcommand, options) {
        switch (subcommand) {
            case 'show':
                console.log('⚙️ Current Configuration:');
                console.log(yaml.dump(this.config, { indent: 2 }));
                break;
            
            case 'path':
                console.log(path.join(__dirname, 'config.yml'));
                break;
            
            default:
                console.log('❌ Unknown config subcommand');
                console.log('Available: show, path');
        }
    }

    // Helper methods

    parseOptions(args) {
        const options = [];
        for (let i = 0; i < args.length; i++) {
            if (args[i].startsWith('--') && args[i].includes('=')) {
                // Handle --key=value format
                options.push(args[i]);
            } else if (args[i].startsWith('--') && i + 1 < args.length && !args[i + 1].startsWith('--')) {
                // Handle --key value format
                options.push(`${args[i]}=${args[i + 1]}`);
                i++; // Skip next argument as it's the value
            } else {
                options.push(args[i]);
            }
        }
        return options;
    }

    getOptionValue(options, key) {
        const option = options.find(opt => opt.startsWith(`${key}=`));
        if (option) {
            return option.split('=')[1];
        }
        
        // Also check for key without equals sign followed by value
        const keyIndex = options.findIndex(opt => opt === key);
        if (keyIndex !== -1 && keyIndex + 1 < options.length) {
            return options[keyIndex + 1];
        }
        
        return null;
    }

    showHelp() {
        console.log(`
🎮 ArcadeDB Admin Tool

USAGE:
    node arcade-admin.js <command> [options]

COMMANDS:
    Container Management:
        start [--with-test-data] [--restart]    Start ArcadeDB container
        stop [--force]                          Stop ArcadeDB container  
        restart [--with-test-data]              Restart ArcadeDB container
        status                                  Show system status

    Database Operations:
        database list                           List all databases
        database create <name> [--schema=file]  Create new database
        database drop <name> [--confirm]        Delete database
        database info <name>                    Show database details
        database users <name>                   Show database users
        database stats                          Show all database statistics

    Backup & Restore:
        backup <database> [--no-verify]         Create database backup
        restore <database> <backup-file> [--overwrite]  Restore from backup
        list-backups [--database=name]          List available backups
        verify-backup <backup-file>              Verify backup integrity

    Data Import/Export:
        import <database> <file> [options]      Import data from file
          --format=json|csv|tsv                 Specify file format
          --type=TypeName                       Target vertex type
          --no-create-type                      Don't create type automatically
          --batch-size=1000                     Records per batch
        
        export <database> <output-file> [options]  Export data to file
          --format=json|csv|tsv                 Output format
          --query="SELECT * FROM V"             Custom query
          --type=TypeName                       Export specific type
          --include-edges                       Include edges in export

    Monitoring & Health:
        health                                  Comprehensive health check
        logs [--lines=50] [--since=1h] [--level=error]  View container logs
        metrics                                 Show performance metrics
        monitor [--duration=60] [--interval=10] Monitor system over time
        diagnostics                             Run system diagnostics

    Maintenance:
        optimize <database>                     Optimize database (planned)
        cleanup [--dry-run] [--older-than=30]  Clean old backups and resources
        clear-databases [--confirm]             Remove all databases (keep backups)
        clean-all [--confirm]                   Remove ALL data including backups

    Configuration:
        config show                             Show current configuration
        config path                             Show config file path

    Help:
        help                                    Show this help
        version                                 Show version

EXAMPLES:
    # Setup and start
    node arcade-admin.js start --with-test-data
    node arcade-admin.js status

    # Database management
    node arcade-admin.js database create MyApp
    node arcade-admin.js database list
    node arcade-admin.js database info MyApp

    # Backup operations
    node arcade-admin.js backup MyApp
    node arcade-admin.js list-backups
    node arcade-admin.js restore MyApp ./backups/MyApp/backup-20250101.zip

    # Data operations
    node arcade-admin.js import MyApp ./data/users.json --type=User
    node arcade-admin.js export MyApp ./exports/myapp.json

    # Monitoring
    node arcade-admin.js health
    node arcade-admin.js logs --lines=100 --level=error
    node arcade-admin.js metrics

    # Maintenance
    node arcade-admin.js cleanup --older-than=30
    node arcade-admin.js clear-databases --confirm

For more information, see the documentation.
        `);
    }

    showVersion() {
        const packageJson = require('./package.json');
        console.log(`ArcadeDB Admin Tool v${packageJson.version}`);
    }
}

// Main execution
async function main() {
    const admin = new ArcadeAdmin();
    await admin.run();
}

// Handle unhandled rejections
process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled rejection:', reason);
    process.exit(1);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught exception:', error.message);
    process.exit(1);
});

// Run if called directly
if (require.main === module) {
    main().catch(error => {
        console.error('❌ Application failed:', error.message);
        process.exit(1);
    });
}

module.exports = ArcadeAdmin;