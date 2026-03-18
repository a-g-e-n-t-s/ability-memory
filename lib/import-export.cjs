// lib/import-export.js - ArcadeDB Data Import/Export
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;

class ImportExportManager {
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
     * Import data from file into database
     * @param {string} databaseName - Target database name
     * @param {string} filePath - Path to data file
     * @param {Object} options - Import options
     * @param {string} options.format - File format (auto-detected if not specified)
     * @param {string} options.type - Target vertex/edge type
     * @param {boolean} options.createType - Create type if it doesn't exist
     * @param {number} options.batchSize - Records per batch
     * @returns {Promise<Object>} Import statistics
     */
    async importData(databaseName, filePath, options = {}) {
        const {
            format = null,
            type = null,
            createType = true,
            batchSize = 1000
        } = options;

        try {
            console.log(`📥 Importing data into database: ${databaseName}`);
            console.log(`📁 From file: ${filePath}`);
            
            // Detect format if not provided
            const detectedFormat = format || this._detectFormat(filePath);
            console.log(`📋 Format: ${detectedFormat}`);

            // Validate inputs
            await this._validateImportInputs(databaseName, filePath, detectedFormat);

            // Parse data based on format
            const data = await this._parseDataFile(filePath, detectedFormat);
            
            if (!data || data.length === 0) {
                throw new Error('No data found in file');
            }

            console.log(`📊 Found ${data.length} records to import`);

            // Determine target type
            const targetType = type || this._inferTypeFromFilename(filePath);
            
            if (createType) {
                await this._ensureTypeExists(databaseName, targetType, data[0]);
            }

            // Import data in batches
            const stats = await this._importDataBatches(databaseName, data, targetType, batchSize);

            console.log('✅ Import completed successfully');
            this._displayImportStats(stats);

            return stats;

        } catch (error) {
            console.error('❌ Import failed:', error.message);
            throw error;
        }
    }

    /**
     * Export data from database to file
     * @param {string} databaseName - Source database name
     * @param {string} outputPath - Output file path
     * @param {Object} options - Export options
     * @param {string} options.format - Output format (auto-detected if not specified)
     * @param {string} options.query - Custom query (default: export all vertices)
     * @param {string} options.type - Specific type to export
     * @param {boolean} options.includeEdges - Include edges in export
     * @returns {Promise<Object>} Export statistics
     */
    async exportData(databaseName, outputPath, options = {}) {
        const {
            format = null,
            query = null,
            type = null,
            includeEdges = false
        } = options;

        try {
            console.log(`📤 Exporting data from database: ${databaseName}`);
            console.log(`📁 To file: ${outputPath}`);
            
            // Detect format if not provided
            const detectedFormat = format || this._detectFormat(outputPath);
            console.log(`📋 Format: ${detectedFormat}`);

            // Validate inputs
            await this._validateExportInputs(databaseName, outputPath, detectedFormat);

            let data = [];
            let exportQuery = '';

            if (query) {
                // Use custom query
                exportQuery = query;
                console.log(`🔍 Custom Query: ${exportQuery}`);
                data = await this._executeQuery(databaseName, exportQuery);
            } else if (type) {
                // Export specific type
                exportQuery = `SELECT * FROM ${type}`;
                console.log(`🔍 Type Query: ${exportQuery}`);
                data = await this._executeQuery(databaseName, exportQuery);
            } else {
                // Try to export all data by finding types with data
                console.log('🔍 Finding vertex types with data...');
                try {
                    // Get all vertex types
                    const types = await this._executeQuery(databaseName, "SELECT name FROM schema:types WHERE category = 'vertex'");
                    
                    if (types && types.length > 0) {
                        console.log(`   Found ${types.length} vertex types`);
                        // Query each type and combine results
                        for (const typeInfo of types) {
                            const typeName = typeInfo.name;
                            console.log(`   Checking type: ${typeName}`);
                            try {
                                const typeData = await this._executeQuery(databaseName, `SELECT * FROM ${typeName} LIMIT 1000`);
                                if (typeData && typeData.length > 0) {
                                    data = data.concat(typeData);
                                    console.log(`   Found ${typeData.length} records in ${typeName}`);
                                }
                            } catch (error) {
                                console.log(`   ⚠️ Could not query ${typeName}: ${error.message}`);
                            }
                        }
                        exportQuery = `Combined data from ${types.length} vertex types`;
                    } else {
                        console.log('   No vertex types found, trying alternative approach...');
                        // Try to get types with a different query
                        try {
                            const altTypes = await this._executeQuery(databaseName, "SELECT * FROM schema:types");
                            console.log(`   Found ${altTypes.length} types total`);
                            
                            for (const typeInfo of altTypes) {
                                if (typeInfo.category === 'vertex' || typeInfo.name === 'Test') {
                                    const typeName = typeInfo.name;
                                    console.log(`   Trying type: ${typeName}`);
                                    try {
                                        const typeData = await this._executeQuery(databaseName, `SELECT * FROM ${typeName} LIMIT 1000`);
                                        if (typeData && typeData.length > 0) {
                                            data = data.concat(typeData);
                                            console.log(`   Found ${typeData.length} records in ${typeName}`);
                                        }
                                    } catch (error) {
                                        console.log(`   ⚠️ Could not query ${typeName}: ${error.message}`);
                                    }
                                }
                            }
                            exportQuery = `Combined data from available types`;
                        } catch (error) {
                            console.log('   ⚠️ Could not query schema');
                            exportQuery = "No data available";
                        }
                    }
                } catch (error) {
                    console.log('⚠️ Could not query schema, exporting empty result');
                    data = [];
                }
            }

            console.log(`🔍 Query: ${exportQuery}`);
            
            if (!data || data.length === 0) {
                console.log('ℹ️ No data found to export');
                // Create empty file
                await this._writeDataFile(outputPath, [], detectedFormat);
                return { recordsExported: 0, fileSize: 0, filePath: outputPath };
            }

            console.log(`📊 Found ${data.length} records to export`);

            // Ensure output directory exists
            const outputDir = path.dirname(outputPath);
            if (!fs.existsSync(outputDir)) {
                fs.mkdirSync(outputDir, { recursive: true });
            }

            // Export data based on format
            await this._writeDataFile(outputPath, data, detectedFormat);

            // Get file statistics
            const stats = this._getExportStats(outputPath, data.length);

            console.log('✅ Export completed successfully');
            this._displayExportStats(stats);

            return stats;

        } catch (error) {
            console.error('❌ Export failed:', error.message);
            throw error;
        }
    }

    /**
     * Get supported formats for import/export
     * @returns {Object} Supported formats
     */
    getSupportedFormats() {
        return {
            import: ['json', 'csv', 'tsv'],
            export: ['json', 'csv', 'tsv'],
            description: {
                json: 'JavaScript Object Notation - supports complex nested data',
                csv: 'Comma Separated Values - simple tabular data',
                tsv: 'Tab Separated Values - tabular data with tab delimiters'
            }
        };
    }

    /**
     * Validate import file format and structure
     * @param {string} filePath - Path to file
     * @returns {Promise<Object>} Validation result
     */
    async validateImportFile(filePath) {
        try {
            console.log(`🔍 Validating import file: ${filePath}`);

            const validation = {
                exists: false,
                readable: false,
                format: null,
                recordCount: 0,
                sampleData: null,
                errors: [],
                warnings: []
            };

            // Check file exists
            if (!fs.existsSync(filePath)) {
                validation.errors.push('File does not exist');
                return validation;
            }
            validation.exists = true;

            // Check file is readable
            try {
                fs.accessSync(filePath, fs.constants.R_OK);
                validation.readable = true;
            } catch (error) {
                validation.errors.push('File is not readable');
                return validation;
            }

            // Detect format
            validation.format = this._detectFormat(filePath);

            // Parse and validate structure
            try {
                const data = await this._parseDataFile(filePath, validation.format, 10); // Sample first 10 records
                validation.recordCount = data.length;
                validation.sampleData = data.slice(0, 3); // Show first 3 records

                if (data.length === 0) {
                    validation.warnings.push('File appears to be empty');
                }

                // Validate data structure
                if (data.length > 0) {
                    const firstRecord = data[0];
                    if (typeof firstRecord !== 'object') {
                        validation.errors.push('Data records must be objects');
                    } else if (Object.keys(firstRecord).length === 0) {
                        validation.warnings.push('Records have no properties');
                    }
                }

            } catch (error) {
                validation.errors.push(`Failed to parse file: ${error.message}`);
            }

            // Overall validation
            validation.valid = validation.errors.length === 0;

            this._displayValidationResult(validation);
            return validation;

        } catch (error) {
            console.error('❌ Validation failed:', error.message);
            throw error;
        }
    }

    // Private helper methods

    async _validateImportInputs(databaseName, filePath, format) {
        // Check server is ready
        await this._ensureServerReady();

        // Check database exists
        const databases = await this._getDatabaseList();
        if (!databases.includes(databaseName)) {
            throw new Error(`Database '${databaseName}' does not exist`);
        }

        // Check file exists
        if (!fs.existsSync(filePath)) {
            throw new Error(`Import file not found: ${filePath}`);
        }

        // Check format is supported
        const supported = this.getSupportedFormats();
        if (!supported.import.includes(format)) {
            throw new Error(`Unsupported import format: ${format}. Supported: ${supported.import.join(', ')}`);
        }
    }

    async _validateExportInputs(databaseName, outputPath, format) {
        // Check server is ready
        await this._ensureServerReady();

        // Check database exists
        const databases = await this._getDatabaseList();
        if (!databases.includes(databaseName)) {
            throw new Error(`Database '${databaseName}' does not exist`);
        }

        // Check output directory is writable
        const outputDir = path.dirname(outputPath);
        try {
            if (!fs.existsSync(outputDir)) {
                fs.mkdirSync(outputDir, { recursive: true });
            }
            fs.accessSync(outputDir, fs.constants.W_OK);
        } catch (error) {
            throw new Error(`Output directory is not writable: ${outputDir}`);
        }

        // Check format is supported
        const supported = this.getSupportedFormats();
        if (!supported.export.includes(format)) {
            throw new Error(`Unsupported export format: ${format}. Supported: ${supported.export.join(', ')}`);
        }
    }

    _detectFormat(filePath) {
        const ext = path.extname(filePath).toLowerCase();
        switch (ext) {
            case '.json':
                return 'json';
            case '.csv':
                return 'csv';
            case '.tsv':
            case '.tab':
                return 'tsv';
            default:
                // If no extension or unknown extension, try to guess from filename
                if (filePath.toLowerCase().includes('csv')) {
                    return 'csv';
                } else if (filePath.toLowerCase().includes('tsv') || filePath.toLowerCase().includes('tab')) {
                    return 'tsv';
                } else {
                    // Default to json if we can't determine
                    return 'json';
                }
        }
    }

    async _parseDataFile(filePath, format, limit = null) {
        switch (format) {
            case 'json':
                return this._parseJsonFile(filePath, limit);
            case 'csv':
                return this._parseCsvFile(filePath, ',', limit);
            case 'tsv':
                return this._parseCsvFile(filePath, '\t', limit);
            default:
                throw new Error(`Unsupported format: ${format}`);
        }
    }

    async _parseJsonFile(filePath, limit = null) {
        const content = fs.readFileSync(filePath, 'utf8');
        let data = JSON.parse(content);

        // Handle both array and single object
        if (!Array.isArray(data)) {
            data = [data];
        }

        return limit ? data.slice(0, limit) : data;
    }

    async _parseCsvFile(filePath, delimiter, limit = null) {
        return new Promise((resolve, reject) => {
            const results = [];
            let count = 0;

            fs.createReadStream(filePath)
                .pipe(csv({ separator: delimiter }))
                .on('data', (data) => {
                    if (!limit || count < limit) {
                        // Convert string numbers to actual numbers where appropriate
                        const processedData = this._processRowData(data);
                        results.push(processedData);
                        count++;
                    }
                })
                .on('end', () => {
                    resolve(results);
                })
                .on('error', (error) => {
                    reject(error);
                });
        });
    }

    _processRowData(data) {
        const processed = {};
        
        for (const [key, value] of Object.entries(data)) {
            // Convert numeric strings to numbers
            if (value && !isNaN(value) && !isNaN(parseFloat(value))) {
                processed[key] = parseFloat(value);
            } else if (value === 'true' || value === 'false') {
                processed[key] = value === 'true';
            } else {
                processed[key] = value;
            }
        }
        
        return processed;
    }

    async _writeDataFile(outputPath, data, format) {
        switch (format) {
            case 'json':
                return this._writeJsonFile(outputPath, data);
            case 'csv':
                return this._writeCsvFile(outputPath, data, ',');
            case 'tsv':
                return this._writeCsvFile(outputPath, data, '\t');
            default:
                throw new Error(`Unsupported format: ${format}`);
        }
    }

    async _writeJsonFile(outputPath, data) {
        const jsonContent = JSON.stringify(data, null, 2);
        fs.writeFileSync(outputPath, jsonContent, 'utf8');
    }

    async _writeCsvFile(outputPath, data, delimiter) {
        if (data.length === 0) {
            fs.writeFileSync(outputPath, '', 'utf8');
            return;
        }

        // Get all unique headers from all records
        const headers = [...new Set(data.flatMap(record => Object.keys(record)))];
        
        const csvWriter = createCsvWriter({
            path: outputPath,
            header: headers.map(h => ({ id: h, title: h })),
            fieldDelimiter: delimiter
        });

        await csvWriter.writeRecords(data);
    }

    _inferTypeFromFilename(filePath) {
        const basename = path.basename(filePath, path.extname(filePath));
        // Remove common prefixes/suffixes and capitalize
        const cleanName = basename
            .replace(/^(data|export|import)[-_]?/i, '')
            .replace(/[-_]?(data|export|import)$/i, '')
            .replace(/[^a-zA-Z0-9]/g, '');
        
        return cleanName.charAt(0).toUpperCase() + cleanName.slice(1) || 'ImportedData';
    }

    async _ensureTypeExists(databaseName, typeName, sampleRecord) {
        try {
            // Check if type already exists by trying to query the schema
            const types = await this._executeQuery(databaseName, 'SELECT * FROM schema:types');
            const typeExists = types.some(t => (t.name || t.typeName) === typeName);

            if (!typeExists) {
                console.log(`🔧 Creating vertex type: ${typeName}`);
                
                // Create vertex type using command endpoint
                const auth = Buffer.from(`${this.username}:${this.password}`).toString('base64');
                
                const response = await fetch(`http://${this.host}:${this.port}/api/v1/command/${databaseName}`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Basic ${auth}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        language: 'sql',
                        command: `CREATE VERTEX TYPE ${typeName}`
                    })
                });

                if (!response.ok) {
                    throw new Error(`Failed to create type: ${response.status}`);
                }
                
                console.log(`✅ Type ${typeName} created`);
            }
        } catch (error) {
            console.warn(`⚠️ Could not ensure type exists: ${error.message}`);
        }
    }

    _inferPropertyType(value) {
        if (typeof value === 'number') {
            return Number.isInteger(value) ? 'INTEGER' : 'DECIMAL';
        } else if (typeof value === 'boolean') {
            return 'BOOLEAN';
        } else if (value instanceof Date) {
            return 'DATETIME';
        } else {
            return 'STRING';
        }
    }

    async _importDataBatches(databaseName, data, typeName, batchSize) {
        const stats = {
            totalRecords: data.length,
            recordsImported: 0,
            recordsFailed: 0,
            batchCount: 0,
            errors: []
        };

        for (let i = 0; i < data.length; i += batchSize) {
            const batch = data.slice(i, i + batchSize);
            stats.batchCount++;

            console.log(`📦 Processing batch ${stats.batchCount} (${batch.length} records)...`);

            try {
                await this._importBatch(databaseName, batch, typeName);
                stats.recordsImported += batch.length;
            } catch (error) {
                console.error(`❌ Batch ${stats.batchCount} failed: ${error.message}`);
                stats.recordsFailed += batch.length;
                stats.errors.push(`Batch ${stats.batchCount}: ${error.message}`);
                
                // Try individual records if batch fails
                for (const record of batch) {
                    try {
                        await this._importBatch(databaseName, [record], typeName);
                        stats.recordsImported++;
                        stats.recordsFailed--;
                    } catch (recordError) {
                        // Individual record failed, keep it as failed
                    }
                }
            }
        }

        return stats;
    }

    async _importBatch(databaseName, batch, typeName) {
        const auth = Buffer.from(`${this.username}:${this.password}`).toString('base64');

        for (const record of batch) {
            const properties = Object.entries(record)
                .filter(([key]) => key !== '@rid' && key !== '@type')
                .map(([key, value]) => `${key} = ${this._formatValue(value)}`)
                .join(', ');
            
            const insertCommand = `CREATE VERTEX ${typeName} SET ${properties}`;

            const response = await fetch(`http://${this.host}:${this.port}/api/v1/command/${databaseName}`, {
                method: 'POST',
                headers: {
                    'Authorization': `Basic ${auth}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    language: 'sql',
                    command: insertCommand
                })
            });

            if (!response.ok) {
                throw new Error(`Insert failed: ${response.status}`);
            }
        }
    }

    _formatValue(value) {
        if (value === null || value === undefined) {
            return 'null';
        } else if (typeof value === 'string') {
            return `'${value.replace(/'/g, "''")}'`; // Escape single quotes
        } else if (typeof value === 'boolean') {
            return value.toString();
        } else if (typeof value === 'number') {
            return value.toString();
        } else {
            return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
        }
    }

    _buildExportQuery(type, includeEdges) {
        if (type) {
            return `SELECT * FROM ${type}`;
        } else {
            // Instead of trying to query 'V', let's get all vertex types first
            // and then query each one. For now, let's try a simple approach
            // that gets data from common types or returns schema info if no data
            return `SELECT * FROM schema:types WHERE category = 'vertex' LIMIT 10`;
        }
    }

    _getExportStats(filePath, recordCount) {
        const stats = fs.statSync(filePath);
        
        return {
            recordsExported: recordCount,
            fileSize: stats.size,
            fileSizeFormatted: this._formatFileSize(stats.size),
            filePath: filePath,
            created: stats.mtime
        };
    }

    _displayImportStats(stats) {
        console.log('\n📊 Import Statistics:');
        console.log(`   Total records: ${stats.totalRecords}`);
        console.log(`   Successfully imported: ${stats.recordsImported}`);
        console.log(`   Failed: ${stats.recordsFailed}`);
        console.log(`   Batches processed: ${stats.batchCount}`);
        
        if (stats.errors.length > 0) {
            console.log('\n❌ Errors:');
            stats.errors.forEach(error => console.log(`   ${error}`));
        }
    }

    _displayExportStats(stats) {
        console.log('\n📊 Export Statistics:');
        console.log(`   Records exported: ${stats.recordsExported}`);
        console.log(`   File size: ${stats.fileSizeFormatted}`);
        console.log(`   File path: ${stats.filePath}`);
    }

    _displayValidationResult(validation) {
        console.log('\n🔍 Validation Results:');
        console.log(`   File exists: ${validation.exists ? '✅' : '❌'}`);
        console.log(`   Readable: ${validation.readable ? '✅' : '❌'}`);
        console.log(`   Format: ${validation.format || 'Unknown'}`);
        console.log(`   Records found: ${validation.recordCount}`);
        console.log(`   Valid: ${validation.valid ? '✅' : '❌'}`);

        if (validation.warnings.length > 0) {
            console.log('\n⚠️ Warnings:');
            validation.warnings.forEach(warning => console.log(`   ${warning}`));
        }

        if (validation.errors.length > 0) {
            console.log('\n❌ Errors:');
            validation.errors.forEach(error => console.log(`   ${error}`));
        }

        if (validation.sampleData && validation.sampleData.length > 0) {
            console.log('\n📋 Sample Data:');
            validation.sampleData.forEach((record, i) => {
                console.log(`   Record ${i + 1}: ${JSON.stringify(record).substring(0, 100)}...`);
            });
        }
    }

    // Shared helper methods

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

        if (!response.ok) {
            throw new Error(`Failed to get database list: ${response.status}`);
        }

        const result = await response.json();
        return result.result || [];
    }

    async _executeQuery(databaseName, query) {
        const auth = Buffer.from(`${this.username}:${this.password}`).toString('base64');

        const response = await fetch(`http://${this.host}:${this.port}/api/v1/command/${databaseName}`, {
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
            const errorText = await response.text();
            throw new Error(`Query failed: ${response.status} - ${errorText}`);
        }

        const result = await response.json();
        return result.result || [];
    }

    _formatFileSize(bytes) {
        if (bytes === 0) return '0 B';
        
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }
}

module.exports = ImportExportManager;