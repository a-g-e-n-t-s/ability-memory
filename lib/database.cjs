// lib/database.js - ArcadeDB Database Management
const fs = require('fs');
const path = require('path');

class DatabaseManager {
    constructor(config) {
        this.config = config;
        this.host = config.server.host;
        this.port = config.server.port;
        this.username = config.server.username;
        this.password = config.server.password;
        this.containerName = config.server.container_name;
        this.dataDir = config.storage.data_dir;
    }

    /**
     * List all databases
     * @returns {Promise<Array>} List of database names
     */
    async listDatabases() {
        try {
            await this._ensureServerReady();
            
            const auth = Buffer.from(`${this.username}:${this.password}`).toString('base64');
            
            const response = await fetch(`http://${this.host}:${this.port}/api/v1/databases`, {
                method: 'GET',
                headers: {
                    'Authorization': `Basic ${auth}`
                }
            });

            if (!response.ok) {
                throw new Error(`Failed to list databases: ${response.status}`);
            }

            const result = await response.json();
            const databases = result.result || [];

            console.log('📋 Available databases:');
            if (databases.length === 0) {
                console.log('ℹ️ No databases found');
            } else {
                databases.forEach(db => {
                    console.log(`  📁 ${db}`);
                });
            }

            return databases;

        } catch (error) {
            console.error('❌ Failed to list databases:', error.message);
            throw error;
        }
    }

    /**
     * Create a new database
     * @param {string} databaseName - Name of the database to create
     * @param {Object} options - Creation options
     * @param {string} options.schema - Optional schema file path
     * @returns {Promise<boolean>} Success status
     */
    async createDatabase(databaseName, options = {}) {
        const { schema = null } = options;

        try {
            console.log(`🆕 Creating database: ${databaseName}`);

            // Validate database name
            this._validateDatabaseName(databaseName);

            await this._ensureServerReady();

            // Check if database already exists
            const databases = await this._getDatabaseList();
            if (databases.includes(databaseName)) {
                throw new Error(`Database '${databaseName}' already exists`);
            }

            // Create database via API
            await this._executeCreateCommand(databaseName);

            console.log(`✅ Database '${databaseName}' created successfully`);

            // Apply schema if provided
            if (schema) {
                await this._applySchema(databaseName, schema);
            }

            // Verify database was created
            const updatedDatabases = await this._getDatabaseList();
            if (!updatedDatabases.includes(databaseName)) {
                throw new Error('Database creation verification failed');
            }

            console.log(`🎉 Database '${databaseName}' is ready for use`);
            return true;

        } catch (error) {
            console.error('❌ Database creation failed:', error.message);
            throw error;
        }
    }

    /**
     * Drop (delete) a database
     * @param {string} databaseName - Name of the database to drop
     * @param {Object} options - Drop options
     * @param {boolean} options.confirm - Skip confirmation prompt
     * @returns {Promise<boolean>} Success status
     */
    async dropDatabase(databaseName, options = {}) {
        const { confirm = false } = options;

        try {
            console.log(`🗑️ Dropping database: ${databaseName}`);

            await this._ensureServerReady();

            // Check if database exists
            const databases = await this._getDatabaseList();
            if (!databases.includes(databaseName)) {
                throw new Error(`Database '${databaseName}' does not exist`);
            }

            // Confirmation check
            if (!confirm) {
                console.log('⚠️ This operation will permanently delete the database and all its data');
                console.log('⚠️ Use --confirm flag to proceed without this warning');
                throw new Error('Database drop cancelled - use --confirm flag to proceed');
            }

            // Execute drop command
            await this._executeDropCommand(databaseName);

            console.log(`✅ Database '${databaseName}' dropped successfully`);

            // Verify database was dropped
            const updatedDatabases = await this._getDatabaseList();
            if (updatedDatabases.includes(databaseName)) {
                throw new Error('Database drop verification failed');
            }

            // Clean up local database files if they exist
            await this._cleanupDatabaseFiles(databaseName);

            return true;

        } catch (error) {
            console.error('❌ Database drop failed:', error.message);
            throw error;
        }
    }

    /**
     * Get detailed information about a database
     * @param {string} databaseName - Name of the database
     * @returns {Promise<Object>} Database information
     */
    async getDatabaseInfo(databaseName) {
        try {
            console.log(`🔍 Getting information for database: ${databaseName}`);

            await this._ensureServerReady();

            // Check if database exists
            const databases = await this._getDatabaseList();
            if (!databases.includes(databaseName)) {
                throw new Error(`Database '${databaseName}' does not exist`);
            }

            // Get database schema info
            const schemaInfo = await this._getDatabaseSchema(databaseName);
            
            // Get database statistics
            const stats = await this._getDatabaseStats(databaseName);

            // Get file system info
            const fileInfo = await this._getDatabaseFileInfo(databaseName);

            const info = {
                name: databaseName,
                schema: schemaInfo,
                statistics: stats,
                files: fileInfo,
                serverInfo: {
                    host: this.host,
                    port: this.port,
                    accessible: true
                }
            };

            this._displayDatabaseInfo(info);
            return info;

        } catch (error) {
            console.error('❌ Failed to get database info:', error.message);
            throw error;
        }
    }

    /**
     * Get database users and permissions
     * @param {string} databaseName - Name of the database
     * @returns {Promise<Array>} List of users with access
     */
    async getDatabaseUsers(databaseName) {
        try {
            console.log(`👥 Getting users for database: ${databaseName}`);

            await this._ensureServerReady();

            // Check if database exists
            const databases = await this._getDatabaseList();
            if (!databases.includes(databaseName)) {
                throw new Error(`Database '${databaseName}' does not exist`);
            }

            console.log(`📋 User information for '${databaseName}':`);
            console.log('ℹ️ ArcadeDB stores users in server-level configuration files');
            console.log('ℹ️ User listing via API is not currently supported by ArcadeDB');
            console.log('💡 Future feature: User management interface will be added in a later version');
            console.log(`👤 Current session user: ${this.username}`);
            console.log('📖 See ArcadeDB documentation for manual user management via console');

            // Return current user info since that's all we can reliably determine
            return [{
                name: this.username,
                type: 'current-session',
                note: 'ArcadeDB user listing not available via API'
            }];

        } catch (error) {
            console.error('❌ Failed to get database users:', error.message);
            throw error;
        }
    }

    /**
     * Check database connection and health
     * @param {string} databaseName - Name of the database
     * @returns {Promise<Object>} Health status
     */
    async checkDatabaseHealth(databaseName) {
        try {
            const health = {
                name: databaseName,
                accessible: false,
                responsive: false,
                fileSystemOk: false,
                errors: []
            };

            // Check if database exists in server
            try {
                const databases = await this._getDatabaseList();
                health.accessible = databases.includes(databaseName);
                
                if (!health.accessible) {
                    health.errors.push('Database not found in server');
                }
            } catch (error) {
                health.errors.push(`Server connection failed: ${error.message}`);
            }

            // Check database responsiveness
            if (health.accessible) {
                try {
                    await this._executeQuery(databaseName, 'SELECT 1 as test');
                    health.responsive = true;
                } catch (error) {
                    health.errors.push(`Database not responsive: ${error.message}`);
                }
            }

            // Check file system
            try {
                const dbPath = path.join(this.dataDir, 'databases', databaseName);
                health.fileSystemOk = fs.existsSync(dbPath);
                
                if (!health.fileSystemOk) {
                    health.errors.push('Database files not found on disk');
                }
            } catch (error) {
                health.errors.push(`File system check failed: ${error.message}`);
            }

            // Overall health
            health.overall = health.accessible && health.responsive && health.fileSystemOk ? 'healthy' : 'unhealthy';

            return health;

        } catch (error) {
            return {
                name: databaseName,
                accessible: false,
                responsive: false,
                fileSystemOk: false,
                overall: 'unhealthy',
                errors: [error.message]
            };
        }
    }

    /**
     * Get statistics for all databases
     * @returns {Promise<Object>} Overall database statistics
     */
    async getDatabaseStats() {
        try {
            const databases = await this._getDatabaseList();
            
            const stats = {
                totalDatabases: databases.length,
                databases: [],
                totalSize: 0,
                totalSizeFormatted: '0 B'
            };

            for (const dbName of databases) {
                try {
                    const fileInfo = await this._getDatabaseFileInfo(dbName);
                    const dbStats = await this._getDatabaseStats(dbName);
                    
                    const dbInfo = {
                        name: dbName,
                        size: fileInfo.size,
                        sizeFormatted: fileInfo.sizeFormatted,
                        recordCount: dbStats.recordCount || 0,
                        typeCount: dbStats.typeCount || 0
                    };

                    stats.databases.push(dbInfo);
                    stats.totalSize += fileInfo.size;
                    
                } catch (error) {
                    console.warn(`⚠️ Could not get stats for ${dbName}: ${error.message}`);
                    stats.databases.push({
                        name: dbName,
                        size: 0,
                        sizeFormatted: '0 B',
                        recordCount: 'unknown',
                        typeCount: 'unknown',
                        error: error.message
                    });
                }
            }

            stats.totalSizeFormatted = this._formatFileSize(stats.totalSize);

            console.log('📊 Database Statistics:');
            console.log(`   Total databases: ${stats.totalDatabases}`);
            console.log(`   Total size: ${stats.totalSizeFormatted}`);
            
            stats.databases.forEach(db => {
                console.log(`   📁 ${db.name}: ${db.sizeFormatted} (${db.recordCount} records)`);
            });

            return stats;

        } catch (error) {
            console.error('❌ Failed to get database statistics:', error.message);
            throw error;
        }
    }

    // Private helper methods

    async _ensureServerReady() {
        try {
            const response = await fetch(`http://${this.host}:${this.port}/api/v1/ready`, {
                signal: AbortSignal.timeout(3000)
            });
            
            if (response.status !== 204) {
                throw new Error('Server is not ready');
            }
        } catch (error) {
            throw new Error('Server is not accessible. Make sure the container is running.');
        }
    }

    async _getDatabaseList() {
        const auth = Buffer.from(`${this.username}:${this.password}`).toString('base64');
        
        const response = await fetch(`http://${this.host}:${this.port}/api/v1/databases`, {
            method: 'GET',
            headers: {
                'Authorization': `Basic ${auth}`
            }
        });

        if (!response.ok) {
            throw new Error(`Failed to get database list: ${response.status}`);
        }

        const result = await response.json();
        return result.result || [];
    }

    _validateDatabaseName(name) {
        if (!name || typeof name !== 'string') {
            throw new Error('Database name is required and must be a string');
        }

        if (name.length < 1 || name.length > 64) {
            throw new Error('Database name must be between 1 and 64 characters');
        }

        if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name)) {
            throw new Error('Database name must start with a letter and contain only letters, numbers, and underscores');
        }

        const reservedNames = ['system', 'temp', 'test'];
        if (reservedNames.includes(name.toLowerCase())) {
            throw new Error(`Database name '${name}' is reserved`);
        }
    }

    async _executeCreateCommand(databaseName) {
        const auth = Buffer.from(`${this.username}:${this.password}`).toString('base64');

        const response = await fetch(`http://${this.host}:${this.port}/api/v1/server`, {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${auth}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                command: `create database ${databaseName}`
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Database creation failed: ${response.status} - ${errorText}`);
        }
    }

    async _executeDropCommand(databaseName) {
        const auth = Buffer.from(`${this.username}:${this.password}`).toString('base64');

        const response = await fetch(`http://${this.host}:${this.port}/api/v1/server`, {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${auth}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                command: `drop database ${databaseName}`
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Database drop failed: ${response.status} - ${errorText}`);
        }
    }

    async _executeQuery(databaseName, query) {
        const auth = Buffer.from(`${this.username}:${this.password}`).toString('base64');

        const response = await fetch(`http://${this.host}:${this.port}/api/v1/query/${databaseName}`, {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${auth}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                language: 'sql',
                command: query
            })
        });

        if (!response.ok) {
            throw new Error(`Query failed: ${response.status}`);
        }

        const result = await response.json();
        return result.result || [];
    }

    async _applySchema(databaseName, schemaPath) {
        try {
            console.log(`📋 Applying schema from: ${schemaPath}`);

            if (!fs.existsSync(schemaPath)) {
                throw new Error(`Schema file not found: ${schemaPath}`);
            }

            const schemaContent = fs.readFileSync(schemaPath, 'utf8');
            const statements = schemaContent.split(';').filter(stmt => stmt.trim());

            for (const statement of statements) {
                if (statement.trim()) {
                    await this._executeQuery(databaseName, statement.trim());
                }
            }

            console.log('✅ Schema applied successfully');
        } catch (error) {
            console.error('❌ Schema application failed:', error.message);
            throw error;
        }
    }

    async _getDatabaseSchema(databaseName) {
        try {
            const types = await this._executeQuery(databaseName, 'SELECT * FROM schema:types');
            const indexes = await this._executeQuery(databaseName, 'SELECT * FROM schema:indexes');

            return {
                types: types.length,
                indexes: indexes.length,
                details: {
                    typeList: types.map(t => t.name || t.typeName),
                    indexList: indexes.map(i => i.name || i.indexName)
                }
            };
        } catch (error) {
            return {
                types: 'unknown',
                indexes: 'unknown',
                error: error.message
            };
        }
    }

    async _getDatabaseStats(databaseName) {
        try {
            // Get basic statistics
            const stats = await this._executeQuery(databaseName, 'SELECT count(*) as total FROM V');
            const types = await this._executeQuery(databaseName, 'SELECT * FROM schema:types');

            return {
                recordCount: stats[0]?.total || 0,
                typeCount: types.length || 0
            };
        } catch (error) {
            return {
                recordCount: 'unknown',
                typeCount: 'unknown',
                error: error.message
            };
        }
    }

    async _getDatabaseFileInfo(databaseName) {
        try {
            const dbPath = path.join(this.dataDir, 'databases', databaseName);
            
            if (!fs.existsSync(dbPath)) {
                return {
                    exists: false,
                    size: 0,
                    sizeFormatted: '0 B',
                    path: dbPath
                };
            }

            let totalSize = 0;
            const files = [];

            const scanDirectory = (dir) => {
                const items = fs.readdirSync(dir);
                items.forEach(item => {
                    const itemPath = path.join(dir, item);
                    const stats = fs.statSync(itemPath);
                    
                    if (stats.isDirectory()) {
                        scanDirectory(itemPath);
                    } else {
                        totalSize += stats.size;
                        files.push({
                            name: item,
                            size: stats.size,
                            modified: stats.mtime
                        });
                    }
                });
            };

            scanDirectory(dbPath);

            return {
                exists: true,
                size: totalSize,
                sizeFormatted: this._formatFileSize(totalSize),
                path: dbPath,
                fileCount: files.length,
                files: files.slice(0, 10) // Only return first 10 files
            };

        } catch (error) {
            return {
                exists: false,
                size: 0,
                sizeFormatted: '0 B',
                error: error.message
            };
        }
    }

    async _cleanupDatabaseFiles(databaseName) {
        try {
            const dbPath = path.join(this.dataDir, 'databases', databaseName);
            
            if (fs.existsSync(dbPath)) {
                fs.rmSync(dbPath, { recursive: true, force: true });
                console.log(`🧹 Cleaned up database files: ${dbPath}`);
            }
        } catch (error) {
            console.warn(`⚠️ Could not clean up database files: ${error.message}`);
        }
    }

    _displayDatabaseInfo(info) {
        console.log(`\n📁 Database: ${info.name}`);
        console.log('═'.repeat(40));
        
        console.log('\n📊 Statistics:');
        console.log(`   Records: ${info.statistics.recordCount}`);
        console.log(`   Types: ${info.statistics.typeCount}`);
        
        console.log('\n📋 Schema:');
        console.log(`   Types: ${info.schema.types}`);
        console.log(`   Indexes: ${info.schema.indexes}`);
        
        if (info.schema.details && info.schema.details.typeList.length > 0) {
            console.log(`   Type list: ${info.schema.details.typeList.join(', ')}`);
        }
        
        console.log('\n💾 File System:');
        console.log(`   Exists: ${info.files.exists ? '✅' : '❌'}`);
        console.log(`   Size: ${info.files.sizeFormatted}`);
        console.log(`   Files: ${info.files.fileCount || 0}`);
        console.log(`   Path: ${info.files.path}`);
        
        console.log('\n🌐 Server:');
        console.log(`   Host: ${info.serverInfo.host}:${info.serverInfo.port}`);
        console.log(`   Accessible: ${info.serverInfo.accessible ? '✅' : '❌'}`);
    }

    _formatFileSize(bytes) {
        if (bytes === 0) return '0 B';
        
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }
}

module.exports = DatabaseManager;