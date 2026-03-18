// lib/container.js - ArcadeDB Container Management
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

class ContainerManager {
    constructor(config) {
        this.config = config;
        this.containerName = config.server.container_name;
        this.host = config.server.host;
        this.port = config.server.port;
        this.username = config.server.username;
        this.password = config.server.password;
        this.dataDir = config.storage.data_dir;
    }

    /**
     * Start ArcadeDB container
     * @param {Object} options - Start options
     * @param {boolean} options.withTestData - Include test data
     * @param {boolean} options.restart - Force restart if already running
     * @returns {Promise<boolean>} Success status
     */
    async start(options = {}) {
        const { withTestData = false, restart = false } = options;

        try {
            console.log('🚀 Starting ArcadeDB container...');

            // Check if already running
            if (await this.isRunning()) {
                if (restart) {
                    console.log('🔄 Restarting existing container...');
                    await this.stop();
                } else {
                    console.log('ℹ️ Container is already running');
                    return true;
                }
            }

            // Ensure data directories exist
            this._ensureDataDirectories();

            // Build and execute docker command
            const dockerCmd = this._buildStartCommand(withTestData);
            console.log('🔧 Starting container...');
            console.log(dockerCmd);
            
            const result = execSync(dockerCmd, { 
                encoding: 'utf8', 
                stdio: ['ignore', 'pipe', 'pipe']
            });
            console.log('✅ Container started successfully');
            const containerId = result.trim().split('\n')[0]; // Get just the container ID
            console.log('Container ID:', containerId);

            // Wait for server to be ready
            const ready = await this._waitForReady(withTestData ? 120 : 60);
            
            if (ready) {
                console.log('🌐 ArcadeDB Studio: http://' + this.host + ':' + this.port);
                console.log('👤 Login: ' + this.username + ' / ' + this.password);
                
                if (withTestData) {
                    console.log('📊 Test data should be available');
                }
                
                return true;
            } else {
                throw new Error('Server failed to start within timeout');
            }

        } catch (error) {
            console.error('❌ Failed to start container:', error.message);
            
            // Show logs for debugging
            try {
                const logs = this.getLogs(20);
                if (logs) {
                    console.log('\n📋 Recent logs:');
                    console.log(logs);
                }
            } catch (logError) {
                // Ignore log errors
            }
            
            throw error;
        }
    }

    /**
     * Stop ArcadeDB container
     * @param {Object} options - Stop options
     * @param {boolean} options.force - Force stop
     * @returns {Promise<boolean>} Success status
     */
    async stop(options = {}) {
        const { force = false } = options;

        try {
            console.log('🛑 Stopping ArcadeDB container...');

            if (!(await this.isRunning())) {
                console.log('ℹ️ Container is not running');
                return true;
            }

            const command = force ? 'kill' : 'stop';
            execSync(`docker ${command} ${this.containerName}`, { stdio: 'ignore' });
            
            console.log('✅ Container stopped');
            return true;
            
        } catch (error) {
            console.error('❌ Failed to stop container:', error.message);
            throw error;
        }
    }

    /**
     * Restart ArcadeDB container
     * @param {Object} options - Restart options
     * @returns {Promise<boolean>} Success status
     */
    async restart(options = {}) {
        console.log('🔄 Restarting ArcadeDB container...');
        await this.stop();
        return await this.start(options);
    }

    /**
     * Get container status information
     * @returns {Promise<Object>} Status information
     */
    async getStatus() {
        const status = {
            container: {
                running: false,
                status: 'not found',
                uptime: null
            },
            server: {
                ready: false,
                accessible: false
            },
            storage: {
                dataDir: path.resolve(this.dataDir),
                exists: fs.existsSync(this.dataDir)
            }
        };

        // Check container status
        try {
            const containerInfo = execSync(
                `docker ps --filter name=${this.containerName} --format "{{.Status}}"`,
                { encoding: 'utf8' }
            ).trim();

            if (containerInfo) {
                status.container.running = true;
                status.container.status = containerInfo;
                
                // Extract uptime if available
                const uptimeMatch = containerInfo.match(/Up ([^,]+)/);
                if (uptimeMatch) {
                    status.container.uptime = uptimeMatch[1];
                }
            }
        } catch (error) {
            // Container not found or not running
        }

        // Check server readiness
        if (status.container.running) {
            try {
                const result = execSync(
                    `curl -s -o /dev/null -w "%{http_code}" http://${this.host}:${this.port}/api/v1/ready`,
                    { encoding: 'utf8', timeout: 3000 }
                );
                
                status.server.accessible = true;
                status.server.ready = result.trim() === '204';
                
            } catch (error) {
                // Server not accessible
            }
        }

        return status;
    }

    /**
     * Check if container is running
     * @returns {Promise<boolean>} Running status
     */
    async isRunning() {
        try {
            const result = execSync(
                `docker ps --filter name=${this.containerName} --format "{{.Names}}"`,
                { encoding: 'utf8' }
            ).trim();
            
            return result === this.containerName;
        } catch (error) {
            return false;
        }
    }

    /**
     * Check if server is ready
     * @returns {Promise<boolean>} Ready status
     */
    async isReady() {
        try {
            const result = execSync(
                `curl -s -o /dev/null -w "%{http_code}" http://${this.host}:${this.port}/api/v1/ready`,
                { encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
            );
            return result.trim() === '204';
        } catch (error) {
            return false;
        }
    }

    /**
     * Get container logs
     * @param {number} lines - Number of lines to retrieve
     * @returns {string} Log output
     */
    getLogs(lines = 50) {
        try {
            const command = `docker logs --tail ${lines} ${this.containerName}`;
            return execSync(command, { encoding: 'utf8' });
        } catch (error) {
            throw new Error(`Failed to get logs: ${error.message}`);
        }
    }

    /**
     * Get container resource usage
     * @returns {Object} Resource usage stats
     */
    getResourceUsage() {
        try {
            if (!this.isRunning()) {
                return null;
            }

            const statsCmd = `docker stats ${this.containerName} --no-stream --format "table {{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}\t{{.NetIO}}\t{{.BlockIO}}"`;
            const output = execSync(statsCmd, { encoding: 'utf8' });
            
            const lines = output.trim().split('\n');
            if (lines.length < 2) return null;
            
            const values = lines[1].split('\t');
            
            return {
                cpu: values[0] || '0%',
                memoryUsage: values[1] || '0B / 0B',
                memoryPercent: values[2] || '0%',
                networkIO: values[3] || '0B / 0B',
                blockIO: values[4] || '0B / 0B'
            };
            
        } catch (error) {
            console.error('Failed to get resource usage:', error.message);
            return null;
        }
    }

    /**
     * Perform health check
     * @returns {Promise<Object>} Health check results
     */
    async healthCheck() {
        const health = {
            overall: 'healthy',
            checks: {}
        };

        // Container running check
        health.checks.containerRunning = await this.isRunning();
        
        // Server ready check
        health.checks.serverReady = await this.isReady();
        
        // Data directory check
        health.checks.dataDirectoryExists = fs.existsSync(this.dataDir);
        
        // Resource usage check
        const resources = this.getResourceUsage();
        if (resources) {
            const memPercent = parseFloat(resources.memoryPercent.replace('%', ''));
            health.checks.memoryOk = memPercent < 90;
        } else {
            health.checks.memoryOk = true; // Can't check if not running
        }

        // Determine overall health
        const failedChecks = Object.values(health.checks).filter(check => !check);
        if (failedChecks.length > 0) {
            health.overall = failedChecks.length === Object.keys(health.checks).length ? 'unhealthy' : 'degraded';
        }

        return health;
    }

    /**
     * Clean up stopped containers and unused images
     */
    cleanup() {
        console.log('🧹 Cleaning up Docker resources...');
        
        try {
            // Remove stopped containers
            execSync('docker container prune -f', { stdio: 'ignore' });
            
            // Remove unused images
            execSync('docker image prune -f', { stdio: 'ignore' });
            
            console.log('✅ Docker cleanup completed');
        } catch (error) {
            console.error('⚠️ Cleanup warning:', error.message);
        }
    }

    // Private helper methods

    _ensureDataDirectories() {
        const databasesDir = path.join(this.dataDir, 'databases');
        const backupsDir = path.join(this.dataDir, 'backups');
        
        [databasesDir, backupsDir].forEach(dir => {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
        });

        console.log(`📁 Data directories: ${path.resolve(this.dataDir)}`);
        
        return { databasesDir, backupsDir };
    }

    _buildStartCommand(withTestData) {
        const { databasesDir, backupsDir } = this._ensureDataDirectories();
        
        let dockerCmd = `docker run --rm -d --name ${this.containerName} ` +
            `-p ${this.port}:2480 -p 2424:2424 ` +
            `-v "${path.resolve(databasesDir)}":/home/arcadedb/databases ` +
            `-v "${path.resolve(backupsDir)}":/home/arcadedb/backups `;

        // Configure Java options
        let javaOpts = `-Darcadedb.server.rootPassword=${this.password}`;
        javaOpts += ` -Darcadedb.server.databaseDirectory=/home/arcadedb/databases`;
        javaOpts += ` -Darcadedb.server.backupDirectory=/home/arcadedb/backups`;

        // Add test data if requested
        if (withTestData) {
            const testDataUrl = 'https://github.com/ArcadeData/arcadedb-datasets/raw/main/orientdb/OpenBeer.gz';
            javaOpts += ` -Darcadedb.server.defaultDatabases=TestDB[root]{import:${testDataUrl}}`;
        }

        dockerCmd += `-e JAVA_OPTS="${javaOpts}" arcadedata/arcadedb:latest`;
        
        return dockerCmd;
    }

    async _waitForReady(maxSeconds = 60) {
        console.log('⏳ Waiting for server to be ready...');
        
        let attempts = 0;
        
        while (attempts < maxSeconds) {
            try {
                const ready = await this.isReady();
                if (ready) {
                    console.log('✅ Server is ready!');
                    return true;
                }
            } catch (error) {
                // Expected during startup
            }

            await new Promise(resolve => setTimeout(resolve, 1000));
            attempts++;

            // Show progress every 10 seconds
            if (attempts % 10 === 0) {
                console.log(`   Progress: ${attempts}/${maxSeconds} seconds`);
                
                // Check if container is still running
                if (!(await this.isRunning())) {
                    throw new Error('Container stopped during startup');
                }
            }
        }

        return false;
    }
}

module.exports = ContainerManager;