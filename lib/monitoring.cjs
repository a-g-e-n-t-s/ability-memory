// lib/monitoring.js - ArcadeDB Monitoring & Health
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

class MonitoringManager {
    constructor(config) {
        this.config = config;
        this.host = config.server.host;
        this.port = config.server.port;
        this.username = config.server.username;
        this.password = config.server.password;
        this.containerName = config.server.container_name;
        this.dataDir = config.storage.data_dir;
        this.logLines = config.defaults.log_lines || 50;
    }

    /**
     * Perform comprehensive health check
     * @returns {Promise<Object>} Complete health assessment
     */
    async performHealthCheck() {
        try {
            console.log('🏥 Performing comprehensive health check...');

            const health = {
                timestamp: new Date().toISOString(),
                overall: 'healthy',
                score: 0,
                maxScore: 0,
                checks: {},
                warnings: [],
                errors: [],
                recommendations: []
            };

            // Container health
            await this._checkContainerHealth(health);
            
            // Server health
            await this._checkServerHealth(health);
            
            // Database health
            await this._checkDatabaseHealth(health);
            
            // Resource health
            await this._checkResourceHealth(health);
            
            // Storage health
            await this._checkStorageHealth(health);
            
            // Connectivity health
            await this._checkConnectivityHealth(health);

            // Calculate overall health
            this._calculateOverallHealth(health);
            
            this._displayHealthReport(health);
            return health;

        } catch (error) {
            console.error('❌ Health check failed:', error.message);
            throw error;
        }
    }

    /**
     * Get container logs with filtering options
     * @param {Object} options - Log options
     * @param {number} options.lines - Number of lines to retrieve
     * @param {string} options.since - Time period (e.g., '1h', '30m')
     * @param {string} options.level - Log level filter
     * @returns {Promise<Object>} Log information
     */
    async getLogs(options = {}) {
        const { 
            lines = this.logLines,
            since = null,
            level = null 
        } = options;

        try {
            console.log(`📋 Retrieving container logs (${lines} lines)...`);

            // Check if container exists
            if (!(await this._isContainerRunning())) {
                throw new Error('Container is not running');
            }

            // Build log command
            let logCmd = `docker logs --tail ${lines}`;
            if (since) {
                logCmd += ` --since ${since}`;
            }
            logCmd += ` ${this.containerName}`;

            const rawLogs = execSync(logCmd, { encoding: 'utf8' });
            
            // Parse and filter logs
            const logLines = rawLogs.split('\n').filter(line => line.trim());
            const filteredLogs = level ? this._filterLogsByLevel(logLines, level) : logLines;

            const logInfo = {
                totalLines: logLines.length,
                filteredLines: filteredLogs.length,
                logs: filteredLogs,
                retrievedAt: new Date().toISOString(),
                options: options
            };

            this._displayLogInfo(logInfo);
            return logInfo;

        } catch (error) {
            console.error('❌ Failed to get logs:', error.message);
            throw error;
        }
    }

    /**
     * Get basic performance metrics
     * @returns {Promise<Object>} Performance metrics
     */
    async getMetrics() {
        try {
            console.log('📊 Collecting performance metrics...');

            const metrics = {
                timestamp: new Date().toISOString(),
                container: {},
                server: {},
                database: {},
                system: {}
            };

            // Container metrics
            await this._collectContainerMetrics(metrics);
            
            // Server metrics
            await this._collectServerMetrics(metrics);
            
            // Database metrics
            await this._collectDatabaseMetrics(metrics);
            
            // System metrics
            await this._collectSystemMetrics(metrics);

            this._displayMetrics(metrics);
            return metrics;

        } catch (error) {
            console.error('❌ Failed to collect metrics:', error.message);
            throw error;
        }
    }

    /**
     * Monitor system for a period and report changes
     * @param {Object} options - Monitoring options
     * @param {number} options.duration - Duration in seconds
     * @param {number} options.interval - Check interval in seconds
     * @returns {Promise<Object>} Monitoring report
     */
    async monitorSystem(options = {}) {
        const { 
            duration = 60,
            interval = 10 
        } = options;

        try {
            console.log(`👀 Monitoring system for ${duration} seconds (${interval}s intervals)...`);

            const monitoring = {
                startTime: new Date(),
                endTime: null,
                duration: duration,
                interval: interval,
                snapshots: [],
                summary: {}
            };

            const iterations = Math.floor(duration / interval);
            
            for (let i = 0; i < iterations; i++) {
                console.log(`📊 Snapshot ${i + 1}/${iterations}...`);
                
                try {
                    const snapshot = await this._takeSnapshot();
                    monitoring.snapshots.push(snapshot);
                } catch (error) {
                    console.warn(`⚠️ Snapshot ${i + 1} failed: ${error.message}`);
                }

                if (i < iterations - 1) {
                    await new Promise(resolve => setTimeout(resolve, interval * 1000));
                }
            }

            monitoring.endTime = new Date();
            monitoring.summary = this._analyzeTrends(monitoring.snapshots);

            this._displayMonitoringReport(monitoring);
            return monitoring;

        } catch (error) {
            console.error('❌ Monitoring failed:', error.message);
            throw error;
        }
    }

    /**
     * Check for common issues and provide recommendations
     * @returns {Promise<Object>} Diagnostic report
     */
    async runDiagnostics() {
        try {
            console.log('🔧 Running system diagnostics...');

            const diagnostics = {
                timestamp: new Date().toISOString(),
                issues: [],
                recommendations: [],
                warnings: [],
                systemInfo: {}
            };

            // Check common issues
            await this._checkCommonIssues(diagnostics);
            
            // Check configuration
            await this._checkConfiguration(diagnostics);
            
            // Check performance issues
            await this._checkPerformanceIssues(diagnostics);
            
            // Check storage issues
            await this._checkStorageIssues(diagnostics);

            // Generate recommendations
            this._generateRecommendations(diagnostics);

            this._displayDiagnosticReport(diagnostics);
            return diagnostics;

        } catch (error) {
            console.error('❌ Diagnostics failed:', error.message);
            throw error;
        }
    }

    /**
     * Get system status summary
     * @returns {Promise<Object>} Status summary
     */
    async getStatus() {
        try {
            const status = {
                timestamp: new Date().toISOString(),
                container: {
                    running: false,
                    status: 'unknown',
                    uptime: null
                },
                server: {
                    accessible: false,
                    ready: false,
                    version: null
                },
                databases: {
                    count: 0,
                    list: []
                },
                storage: {
                    dataDir: this.dataDir,
                    exists: fs.existsSync(this.dataDir),
                    size: 0
                },
                lastCheck: new Date().toISOString()
            };

            // Container status
            await this._getContainerStatus(status);
            
            // Server status
            await this._getServerStatus(status);
            
            // Database status
            await this._getDatabaseStatus(status);
            
            // Storage status
            await this._getStorageStatus(status);

            return status;

        } catch (error) {
            console.error('❌ Failed to get status:', error.message);
            throw error;
        }
    }

    // Private helper methods for health checks

    async _checkContainerHealth(health) {
        health.checks.container = { score: 0, maxScore: 3, details: {} };
        
        try {
            // Check if container exists and is running
            const running = await this._isContainerRunning();
            if (running) {
                health.checks.container.score += 1;
                health.checks.container.details.running = '✅ Running';
                
                // Check container status
                const containerInfo = this._getContainerInfo();
                if (containerInfo && !containerInfo.includes('Restarting')) {
                    health.checks.container.score += 1;
                    health.checks.container.details.status = '✅ Stable';
                } else {
                    health.checks.container.details.status = '⚠️ Unstable';
                    health.warnings.push('Container appears to be restarting');
                }
                
                // Check uptime
                const uptime = this._getContainerUptime();
                if (uptime && uptime > 60) { // Running for more than 1 minute
                    health.checks.container.score += 1;
                    health.checks.container.details.uptime = `✅ ${uptime}s`;
                } else {
                    health.checks.container.details.uptime = `⚠️ Recently started`;
                    health.warnings.push('Container was recently started');
                }
                
            } else {
                health.checks.container.details.running = '❌ Not running';
                health.errors.push('Container is not running');
            }
        } catch (error) {
            health.checks.container.details.error = error.message;
            health.errors.push(`Container check failed: ${error.message}`);
        }
        
        health.score += health.checks.container.score;
        health.maxScore += health.checks.container.maxScore;
    }

    async _checkServerHealth(health) {
        health.checks.server = { score: 0, maxScore: 3, details: {} };
        
        try {
            // Check server accessibility
            const accessible = await this._isServerAccessible();
            if (accessible) {
                health.checks.server.score += 1;
                health.checks.server.details.accessible = '✅ Accessible';
                
                // Check server ready status
                const ready = await this._isServerReady();
                if (ready) {
                    health.checks.server.score += 1;
                    health.checks.server.details.ready = '✅ Ready';
                    
                    // Check response time
                    const responseTime = await this._measureResponseTime();
                    if (responseTime < 1000) { // Less than 1 second
                        health.checks.server.score += 1;
                        health.checks.server.details.responseTime = `✅ ${responseTime}ms`;
                    } else {
                        health.checks.server.details.responseTime = `⚠️ ${responseTime}ms (slow)`;
                        health.warnings.push('Server response time is slow');
                    }
                } else {
                    health.checks.server.details.ready = '❌ Not ready';
                    health.errors.push('Server is not ready');
                }
            } else {
                health.checks.server.details.accessible = '❌ Not accessible';
                health.errors.push('Server is not accessible');
            }
        } catch (error) {
            health.checks.server.details.error = error.message;
            health.errors.push(`Server check failed: ${error.message}`);
        }
        
        health.score += health.checks.server.score;
        health.maxScore += health.checks.server.maxScore;
    }

    async _checkDatabaseHealth(health) {
        health.checks.databases = { score: 0, maxScore: 2, details: {} };
        
        try {
            if (await this._isServerReady()) {
                const databases = await this._getDatabaseList();
                
                health.checks.databases.details.count = databases.length;
                if (databases.length >= 0) {
                    health.checks.databases.score += 1;
                    health.checks.databases.details.listing = '✅ Can list databases';
                    
                    // Test database connectivity
                    if (databases.length > 0) {
                        const testDb = databases[0];
                        try {
                            await this._testDatabaseQuery(testDb);
                            health.checks.databases.score += 1;
                            health.checks.databases.details.connectivity = `✅ ${testDb} accessible`;
                        } catch (error) {
                            health.checks.databases.details.connectivity = `⚠️ ${testDb} query failed`;
                            health.warnings.push(`Database ${testDb} query test failed`);
                        }
                    } else {
                        health.checks.databases.score += 1; // No databases is also valid
                        health.checks.databases.details.connectivity = '✅ No databases to test';
                    }
                }
            } else {
                health.checks.databases.details.listing = '❌ Server not ready';
            }
        } catch (error) {
            health.checks.databases.details.error = error.message;
            health.warnings.push(`Database check failed: ${error.message}`);
        }
        
        health.score += health.checks.databases.score;
        health.maxScore += health.checks.databases.maxScore;
    }

    async _checkResourceHealth(health) {
        health.checks.resources = { score: 0, maxScore: 3, details: {} };
        
        try {
            if (await this._isContainerRunning()) {
                const resources = this._getContainerResources();
                
                if (resources) {
                    // Check memory usage
                    const memPercent = parseFloat(resources.memoryPercent?.replace('%', '') || '0');
                    if (memPercent < 80) {
                        health.checks.resources.score += 1;
                        health.checks.resources.details.memory = `✅ ${resources.memoryPercent}`;
                    } else if (memPercent < 95) {
                        health.checks.resources.details.memory = `⚠️ ${resources.memoryPercent} (high)`;
                        health.warnings.push('Memory usage is high');
                    } else {
                        health.checks.resources.details.memory = `❌ ${resources.memoryPercent} (critical)`;
                        health.errors.push('Memory usage is critical');
                    }
                    
                    // Check CPU usage
                    const cpuPercent = parseFloat(resources.cpu?.replace('%', '') || '0');
                    if (cpuPercent < 80) {
                        health.checks.resources.score += 1;
                        health.checks.resources.details.cpu = `✅ ${resources.cpu}`;
                    } else {
                        health.checks.resources.details.cpu = `⚠️ ${resources.cpu} (high)`;
                        health.warnings.push('CPU usage is high');
                    }
                    
                    // Check network I/O
                    health.checks.resources.score += 1;
                    health.checks.resources.details.network = `✅ ${resources.networkIO}`;
                    
                } else {
                    health.checks.resources.details.error = 'Could not get resource information';
                }
            }
        } catch (error) {
            health.checks.resources.details.error = error.message;
            health.warnings.push(`Resource check failed: ${error.message}`);
        }
        
        health.score += health.checks.resources.score;
        health.maxScore += health.checks.resources.maxScore;
    }

    async _checkStorageHealth(health) {
        health.checks.storage = { score: 0, maxScore: 2, details: {} };
        
        try {
            // Check data directory exists
            if (fs.existsSync(this.dataDir)) {
                health.checks.storage.score += 1;
                health.checks.storage.details.dataDir = '✅ Exists';
                
                // Check storage space
                const storageInfo = this._getStorageInfo();
                if (storageInfo.freeSpacePercent > 10) {
                    health.checks.storage.score += 1;
                    health.checks.storage.details.space = `✅ ${storageInfo.freeSpacePercent}% free`;
                } else {
                    health.checks.storage.details.space = `⚠️ ${storageInfo.freeSpacePercent}% free (low)`;
                    health.warnings.push('Storage space is low');
                }
            } else {
                health.checks.storage.details.dataDir = '❌ Missing';
                health.errors.push('Data directory does not exist');
            }
        } catch (error) {
            health.checks.storage.details.error = error.message;
            health.warnings.push(`Storage check failed: ${error.message}`);
        }
        
        health.score += health.checks.storage.score;
        health.maxScore += health.checks.storage.maxScore;
    }

    async _checkConnectivityHealth(health) {
        health.checks.connectivity = { score: 0, maxScore: 2, details: {} };
        
        try {
            // Check port accessibility
            const portOpen = await this._isPortOpen(this.port);
            if (portOpen) {
                health.checks.connectivity.score += 1;
                health.checks.connectivity.details.port = `✅ Port ${this.port} open`;
                
                // Check HTTP response
                try {
                    const response = await fetch(`http://${this.host}:${this.port}`, {
                        signal: AbortSignal.timeout(5000)
                    });
                    health.checks.connectivity.score += 1;
                    health.checks.connectivity.details.http = `✅ HTTP ${response.status}`;
                } catch (error) {
                    health.checks.connectivity.details.http = '⚠️ HTTP connection failed';
                    health.warnings.push('HTTP connection test failed');
                }
            } else {
                health.checks.connectivity.details.port = `❌ Port ${this.port} closed`;
                health.errors.push(`Port ${this.port} is not accessible`);
            }
        } catch (error) {
            health.checks.connectivity.details.error = error.message;
            health.warnings.push(`Connectivity check failed: ${error.message}`);
        }
        
        health.score += health.checks.connectivity.score;
        health.maxScore += health.checks.connectivity.maxScore;
    }

    _calculateOverallHealth(health) {
        const percentage = health.maxScore > 0 ? (health.score / health.maxScore) * 100 : 0;
        
        if (percentage >= 90) {
            health.overall = 'healthy';
        } else if (percentage >= 70) {
            health.overall = 'degraded';
        } else if (percentage >= 50) {
            health.overall = 'unhealthy';
        } else {
            health.overall = 'critical';
        }
        
        health.percentage = Math.round(percentage);
    }

    // Helper methods for monitoring operations

    async _isContainerRunning() {
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

    async _isServerAccessible() {
        try {
            const response = await fetch(`http://${this.host}:${this.port}`, {
                signal: AbortSignal.timeout(3000)
            });
            return response.status < 500;
        } catch (error) {
            return false;
        }
    }

    async _isServerReady() {
        try {
            const response = await fetch(`http://${this.host}:${this.port}/api/v1/ready`, {
                signal: AbortSignal.timeout(3000)
            });
            return response.status === 204;
        } catch (error) {
            return false;
        }
    }

    async _measureResponseTime() {
        const start = Date.now();
        try {
            await fetch(`http://${this.host}:${this.port}/api/v1/ready`, {
                signal: AbortSignal.timeout(5000)
            });
            return Date.now() - start;
        } catch (error) {
            return 9999; // Timeout or error
        }
    }

    _getContainerInfo() {
        try {
            return execSync(
                `docker ps --filter name=${this.containerName} --format "{{.Status}}"`,
                { encoding: 'utf8' }
            ).trim();
        } catch (error) {
            return null;
        }
    }

    _getContainerUptime() {
        try {
            const status = this._getContainerInfo();
            if (status && status.includes('Up')) {
                const match = status.match(/Up (\d+) (\w+)/);
                if (match) {
                    const [, value, unit] = match;
                    const multipliers = { seconds: 1, minutes: 60, hours: 3600, days: 86400 };
                    return parseInt(value) * (multipliers[unit] || 1);
                }
            }
            return 0;
        } catch (error) {
            return 0;
        }
    }

    _getContainerResources() {
        try {
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
            return null;
        }
    }

    _getStorageInfo() {
        try {
            // Get disk usage for data directory
            const output = execSync(`df -h "${this.dataDir}"`, { encoding: 'utf8' });
            const lines = output.trim().split('\n');
            if (lines.length >= 2) {
                const values = lines[1].split(/\s+/);
                const used = values[4]?.replace('%', '') || '0';
                const freeSpacePercent = 100 - parseInt(used);
                
                return {
                    total: values[1] || '0',
                    used: values[2] || '0',
                    available: values[3] || '0',
                    usedPercent: parseInt(used),
                    freeSpacePercent: freeSpacePercent
                };
            }
        } catch (error) {
            // Fallback for systems without df command
        }
        
        return {
            total: 'unknown',
            used: 'unknown', 
            available: 'unknown',
            usedPercent: 0,
            freeSpacePercent: 100
        };
    }

    async _isPortOpen(port) {
        return new Promise((resolve) => {
            const net = require('net');
            const socket = new net.Socket();
            
            socket.setTimeout(3000);
            socket.on('connect', () => {
                socket.destroy();
                resolve(true);
            });
            socket.on('timeout', () => {
                socket.destroy();
                resolve(false);
            });
            socket.on('error', () => {
                resolve(false);
            });
            
            socket.connect(port, this.host);
        });
    }

    async _getDatabaseList() {
        try {
            const auth = Buffer.from(`${this.username}:${this.password}`).toString('base64');
            
            const response = await fetch(`http://${this.host}:${this.port}/api/v1/server`, {
                method: 'POST',
                headers: {
                    'Authorization': `Basic ${auth}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    language: 'sql',
                    command: 'list databases'
                })
            });

            if (response.ok) {
                const result = await response.json();
                return result.result || [];
            }
            return [];
        } catch (error) {
            return [];
        }
    }

    async _testDatabaseQuery(databaseName) {
        const auth = Buffer.from(`${this.username}:${this.password}`).toString('base64');
        
        const response = await fetch(`http://${this.host}:${this.port}/api/v1/command/${databaseName}`, {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${auth}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                language: 'sql',
                command: 'SELECT 1 as test'
            })
        });

        if (!response.ok) {
            throw new Error(`Query failed: ${response.status}`);
        }
    }

    // Display methods

    _displayHealthReport(health) {
        console.log('\n🏥 Health Check Report');
        console.log('═'.repeat(50));
        console.log(`Overall Health: ${this._getHealthIcon(health.overall)} ${health.overall.toUpperCase()}`);
        console.log(`Score: ${health.score}/${health.maxScore} (${health.percentage}%)`);
        console.log(`Timestamp: ${health.timestamp}`);

        console.log('\n📋 Detailed Checks:');
        Object.entries(health.checks).forEach(([category, check]) => {
            const percentage = check.maxScore > 0 ? Math.round((check.score / check.maxScore) * 100) : 0;
            console.log(`\n  ${category.toUpperCase()}: ${check.score}/${check.maxScore} (${percentage}%)`);
            
            Object.entries(check.details).forEach(([key, value]) => {
                console.log(`    ${key}: ${value}`);
            });
        });

        if (health.warnings.length > 0) {
            console.log('\n⚠️ Warnings:');
            health.warnings.forEach(warning => console.log(`  ${warning}`));
        }

        if (health.errors.length > 0) {
            console.log('\n❌ Errors:');
            health.errors.forEach(error => console.log(`  ${error}`));
        }
    }

    _displayLogInfo(logInfo) {
        console.log(`\n📋 Container Logs (${logInfo.filteredLines}/${logInfo.totalLines} lines)`);
        console.log('═'.repeat(50));
        
        if (logInfo.logs.length === 0) {
            console.log('ℹ️ No logs found');
        } else {
            logInfo.logs.slice(-20).forEach(line => { // Show last 20 lines
                console.log(line);
            });
            
            if (logInfo.logs.length > 20) {
                console.log(`\n... (showing last 20 of ${logInfo.logs.length} lines)`);
            }
        }
    }

    _displayMetrics(metrics) {
        console.log('\n📊 Performance Metrics');
        console.log('═'.repeat(50));
        console.log(`Timestamp: ${metrics.timestamp}`);

        if (metrics.container.running) {
            console.log('\n🐳 Container:');
            console.log(`  CPU: ${metrics.container.cpu || 'N/A'}`);
            console.log(`  Memory: ${metrics.container.memory || 'N/A'}`);
            console.log(`  Network I/O: ${metrics.container.networkIO || 'N/A'}`);
        }

        if (metrics.server.accessible) {
            console.log('\n🌐 Server:');
            console.log(`  Response Time: ${metrics.server.responseTime || 'N/A'}ms`);
            console.log(`  Status: ${metrics.server.ready ? 'Ready' : 'Not Ready'}`);
        }

        console.log('\n💾 Storage:');
        console.log(`  Data Directory Size: ${metrics.system.dataDirSize || 'N/A'}`);
        console.log(`  Available Space: ${metrics.system.availableSpace || 'N/A'}`);
    }

    _getHealthIcon(status) {
        const icons = {
            healthy: '✅',
            degraded: '⚠️',
            unhealthy: '❌',
            critical: '🚨'
        };
        return icons[status] || '❓';
    }

    _filterLogsByLevel(logLines, level) {
        const levelPatterns = {
            error: /error|exception|fail|fatal/i,
            warn: /warn|warning/i,
            info: /info|information/i,
            debug: /debug|trace/i
        };

        const pattern = levelPatterns[level.toLowerCase()];
        return pattern ? logLines.filter(line => pattern.test(line)) : logLines;
    }

    // Placeholder methods for advanced features
    async _collectContainerMetrics(metrics) {
        if (await this._isContainerRunning()) {
            const resources = this._getContainerResources();
            metrics.container = {
                running: true,
                cpu: resources?.cpu || 'N/A',
                memory: resources?.memoryUsage || 'N/A',
                networkIO: resources?.networkIO || 'N/A'
            };
        } else {
            metrics.container = { running: false };
        }
    }

    async _collectServerMetrics(metrics) {
        if (await this._isServerAccessible()) {
            const responseTime = await this._measureResponseTime();
            metrics.server = {
                accessible: true,
                ready: await this._isServerReady(),
                responseTime: responseTime
            };
        } else {
            metrics.server = { accessible: false };
        }
    }

    async _collectDatabaseMetrics(metrics) {
        try {
            const databases = await this._getDatabaseList();
            metrics.database = {
                count: databases.length,
                list: databases
            };
        } catch (error) {
            metrics.database = { count: 0, error: error.message };
        }
    }

    async _collectSystemMetrics(metrics) {
        const storageInfo = this._getStorageInfo();
        metrics.system = {
            dataDirSize: this._getDirectorySize(this.dataDir),
            availableSpace: storageInfo.available,
            usedSpacePercent: storageInfo.usedPercent
        };
    }

    async _takeSnapshot() {
        const snapshot = {
            timestamp: new Date().toISOString(),
            container: await this._isContainerRunning(),
            server: await this._isServerReady(),
            resources: this._getContainerResources(),
            responseTime: await this._measureResponseTime()
        };
        return snapshot;
    }

    _analyzeTrends(snapshots) {
        if (snapshots.length === 0) return {};

        const summary = {
            totalSnapshots: snapshots.length,
            containerUptime: 0,
            serverUptime: 0,
            avgResponseTime: 0,
            maxResponseTime: 0,
            minResponseTime: Infinity,
            trends: {}
        };

        let responseTimeSum = 0;
        let validResponseTimes = 0;

        snapshots.forEach(snapshot => {
            if (snapshot.container) summary.containerUptime++;
            if (snapshot.server) summary.serverUptime++;
            
            if (snapshot.responseTime && snapshot.responseTime < 9999) {
                responseTimeSum += snapshot.responseTime;
                validResponseTimes++;
                summary.maxResponseTime = Math.max(summary.maxResponseTime, snapshot.responseTime);
                summary.minResponseTime = Math.min(summary.minResponseTime, snapshot.responseTime);
            }
        });

        if (validResponseTimes > 0) {
            summary.avgResponseTime = Math.round(responseTimeSum / validResponseTimes);
        }

        summary.containerUptimePercent = Math.round((summary.containerUptime / snapshots.length) * 100);
        summary.serverUptimePercent = Math.round((summary.serverUptime / snapshots.length) * 100);

        return summary;
    }

    _displayMonitoringReport(monitoring) {
        console.log('\n👀 Monitoring Report');
        console.log('═'.repeat(50));
        console.log(`Duration: ${monitoring.duration} seconds`);
        console.log(`Snapshots: ${monitoring.snapshots.length}`);
        console.log(`Start: ${monitoring.startTime.toLocaleString()}`);
        console.log(`End: ${monitoring.endTime.toLocaleString()}`);

        const summary = monitoring.summary;
        console.log('\n📊 Summary:');
        console.log(`  Container uptime: ${summary.containerUptimePercent}%`);
        console.log(`  Server uptime: ${summary.serverUptimePercent}%`);
        console.log(`  Avg response time: ${summary.avgResponseTime}ms`);
        console.log(`  Min response time: ${summary.minResponseTime === Infinity ? 'N/A' : summary.minResponseTime + 'ms'}`);
        console.log(`  Max response time: ${summary.maxResponseTime}ms`);
    }

    async _checkCommonIssues(diagnostics) {
        // Check if container exists but is not running
        try {
            const containerExists = execSync(`docker ps -a --filter name=${this.containerName} --format "{{.Names}}"`, { encoding: 'utf8' }).trim();
            const containerRunning = await this._isContainerRunning();
            
            if (containerExists && !containerRunning) {
                diagnostics.issues.push({
                    type: 'container',
                    severity: 'high',
                    message: 'Container exists but is not running',
                    recommendation: 'Start the container with: node arcade-admin.js start'
                });
            }
        } catch (error) {
            // Container doesn't exist
        }

        // Check for port conflicts
        const portInUse = await this._isPortOpen(this.port);
        const serverAccessible = await this._isServerAccessible();
        
        if (portInUse && !serverAccessible) {
            diagnostics.issues.push({
                type: 'network',
                severity: 'medium',
                message: `Port ${this.port} is in use but ArcadeDB is not accessible`,
                recommendation: 'Check if another service is using the port'
            });
        }

        // Check for disk space issues
        const storageInfo = this._getStorageInfo();
        if (storageInfo.freeSpacePercent < 5) {
            diagnostics.issues.push({
                type: 'storage',
                severity: 'critical',
                message: 'Very low disk space',
                recommendation: 'Free up disk space or move data directory to a larger volume'
            });
        } else if (storageInfo.freeSpacePercent < 15) {
            diagnostics.warnings.push('Disk space is getting low');
        }
    }

    async _checkConfiguration(diagnostics) {
        // Check if data directory exists and is writable
        try {
            if (!fs.existsSync(this.dataDir)) {
                diagnostics.issues.push({
                    type: 'configuration',
                    severity: 'high',
                    message: 'Data directory does not exist',
                    recommendation: 'Create data directory or check configuration'
                });
            } else {
                fs.accessSync(this.dataDir, fs.constants.W_OK);
            }
        } catch (error) {
            diagnostics.issues.push({
                type: 'configuration',
                severity: 'high',
                message: 'Data directory is not writable',
                recommendation: 'Check directory permissions'
            });
        }

        // Check Docker availability
        try {
            execSync('docker --version', { stdio: 'ignore' });
        } catch (error) {
            diagnostics.issues.push({
                type: 'system',
                severity: 'critical',
                message: 'Docker is not available',
                recommendation: 'Install Docker or ensure it is running'
            });
        }
    }

    async _checkPerformanceIssues(diagnostics) {
        if (await this._isContainerRunning()) {
            const resources = this._getContainerResources();
            
            if (resources) {
                const memPercent = parseFloat(resources.memoryPercent?.replace('%', '') || '0');
                const cpuPercent = parseFloat(resources.cpu?.replace('%', '') || '0');
                
                if (memPercent > 90) {
                    diagnostics.issues.push({
                        type: 'performance',
                        severity: 'high',
                        message: `High memory usage: ${memPercent}%`,
                        recommendation: 'Consider increasing container memory limit or optimizing databases'
                    });
                }
                
                if (cpuPercent > 80) {
                    diagnostics.warnings.push(`High CPU usage: ${cpuPercent}%`);
                }
            }

            // Check response time
            const responseTime = await this._measureResponseTime();
            if (responseTime > 2000) {
                diagnostics.issues.push({
                    type: 'performance',
                    severity: 'medium',
                    message: `Slow response time: ${responseTime}ms`,
                    recommendation: 'Check server load and database optimization'
                });
            }
        }
    }

    async _checkStorageIssues(diagnostics) {
        if (fs.existsSync(this.dataDir)) {
            const dataDirSize = this._getDirectorySize(this.dataDir);
            
            // Check for very large databases
            const databasesDir = path.join(this.dataDir, 'databases');
            if (fs.existsSync(databasesDir)) {
                try {
                    const databases = fs.readdirSync(databasesDir, { withFileTypes: true })
                        .filter(item => item.isDirectory());
                    
                    databases.forEach(db => {
                        const dbPath = path.join(databasesDir, db.name);
                        const dbSize = this._getDirectorySize(dbPath);
                        
                        if (dbSize > 1024 * 1024 * 1024) { // > 1GB
                            diagnostics.warnings.push(`Large database detected: ${db.name} (${this._formatFileSize(dbSize)})`);
                        }
                    });
                } catch (error) {
                    // Ignore errors reading database directory
                }
            }
        }
    }

    _generateRecommendations(diagnostics) {
        const criticalIssues = diagnostics.issues.filter(issue => issue.severity === 'critical');
        const highIssues = diagnostics.issues.filter(issue => issue.severity === 'high');
        
        if (criticalIssues.length > 0) {
            diagnostics.recommendations.push('🚨 Address critical issues immediately to restore functionality');
        }
        
        if (highIssues.length > 0) {
            diagnostics.recommendations.push('⚠️ Resolve high priority issues to prevent system problems');
        }
        
        if (diagnostics.warnings.length > 3) {
            diagnostics.recommendations.push('💡 Consider running regular maintenance to address warnings');
        }
        
        // Add general recommendations
        diagnostics.recommendations.push('📋 Run health checks regularly to monitor system status');
        diagnostics.recommendations.push('💾 Schedule regular backups of important databases');
        diagnostics.recommendations.push('🧹 Perform cleanup operations to maintain optimal performance');
    }

    _displayDiagnosticReport(diagnostics) {
        console.log('\n🔧 Diagnostic Report');
        console.log('═'.repeat(50));
        console.log(`Timestamp: ${diagnostics.timestamp}`);

        if (diagnostics.issues.length === 0) {
            console.log('\n✅ No issues detected');
        } else {
            console.log('\n❌ Issues Found:');
            diagnostics.issues.forEach((issue, i) => {
                const severityIcon = issue.severity === 'critical' ? '🚨' : 
                                   issue.severity === 'high' ? '❌' : '⚠️';
                console.log(`\n  ${i + 1}. ${severityIcon} ${issue.message}`);
                console.log(`     Type: ${issue.type}`);
                console.log(`     Severity: ${issue.severity}`);
                console.log(`     Recommendation: ${issue.recommendation}`);
            });
        }

        if (diagnostics.warnings.length > 0) {
            console.log('\n⚠️ Warnings:');
            diagnostics.warnings.forEach((warning, i) => {
                console.log(`  ${i + 1}. ${warning}`);
            });
        }

        if (diagnostics.recommendations.length > 0) {
            console.log('\n💡 Recommendations:');
            diagnostics.recommendations.forEach((rec, i) => {
                console.log(`  ${i + 1}. ${rec}`);
            });
        }
    }

    async _getContainerStatus(status) {
        try {
            const containerInfo = execSync(
                `docker ps --filter name=${this.containerName} --format "{{.Names}}\\t{{.Status}}"`,
                { encoding: 'utf8' }
            ).trim();
            
            if (containerInfo) {
                const parts = containerInfo.split('\t');
                status.container.running = true;
                status.container.status = parts[1] || 'unknown';
                
                const uptime = this._getContainerUptime();
                status.container.uptime = uptime > 0 ? `${uptime} seconds` : null;
            }
        } catch (error) {
            // Container not running
        }
    }

    async _getServerStatus(status) {
        try {
            if (status.container.running) {
                status.server.accessible = await this._isServerAccessible();
                status.server.ready = await this._isServerReady();
                
                if (status.server.ready) {
                    // Try to get version info if available
                    try {
                        const auth = Buffer.from(`${this.username}:${this.password}`).toString('base64');
                        const response = await fetch(`http://${this.host}:${this.port}/api/v1/server`, {
                            method: 'POST',
                            headers: {
                                'Authorization': `Basic ${auth}`,
                                'Content-Type': 'application/json'
                            },
                            body: JSON.stringify({
                                language: 'sql',
                                command: 'SELECT version() as version'
                            })
                        });
                        
                        if (response.ok) {
                            const result = await response.json();
                            if (result.result && result.result[0]) {
                                status.server.version = result.result[0].version;
                            }
                        }
                    } catch (error) {
                        // Version info not critical
                    }
                }
            }
        } catch (error) {
            // Server status check failed
        }
    }

    async _getDatabaseStatus(status) {
        try {
            if (status.server.ready) {
                const databases = await this._getDatabaseList();
                status.databases.count = databases.length;
                status.databases.list = databases;
            }
        } catch (error) {
            // Database status check failed
        }
    }

    async _getStorageStatus(status) {
        try {
            if (fs.existsSync(this.dataDir)) {
                status.storage.size = this._getDirectorySize(this.dataDir);
                status.storage.sizeFormatted = this._formatFileSize(status.storage.size);
            }
        } catch (error) {
            // Storage status check failed
        }
    }

    _getDirectorySize(dirPath) {
        try {
            if (!fs.existsSync(dirPath)) return 0;
            
            let totalSize = 0;
            const items = fs.readdirSync(dirPath);
            
            items.forEach(item => {
                const itemPath = path.join(dirPath, item);
                const stats = fs.statSync(itemPath);
                
                if (stats.isDirectory()) {
                    totalSize += this._getDirectorySize(itemPath);
                } else {
                    totalSize += stats.size;
                }
            });
            
            return totalSize;
        } catch (error) {
            return 0;
        }
    }

    _formatFileSize(bytes) {
        if (bytes === 0) return '0 B';
        
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }
}

module.exports = MonitoringManager;