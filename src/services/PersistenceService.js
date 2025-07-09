const fs = require('fs').promises;
const path = require('path');
const logger = require('../utils/logger');

class PersistenceService {
    constructor(filePath = './data/queue-configurations.json') {
        this.filePath = filePath;
        this.dataDir = path.dirname(filePath);
        this.isReady = false;
        
        this.init();
    }

    /**
     * Inicializa o serviço de persistência
     */
    async init() {
        try {
            // Garantir que o diretório existe
            await this.ensureDataDirectory();
            
            // Verificar se o arquivo existe, senão criar um vazio
            await this.ensureConfigFile();
            
            this.isReady = true;
            logger.info('Persistence service initialized successfully', { filePath: this.filePath });
        } catch (error) {
            logger.error('Failed to initialize persistence service', error);
            throw error;
        }
    }

    /**
     * Garante que o diretório de dados existe
     */
    async ensureDataDirectory() {
        try {
            await fs.access(this.dataDir);
        } catch (error) {
            if (error.code === 'ENOENT') {
                await fs.mkdir(this.dataDir, { recursive: true });
                logger.info('Created data directory', { dir: this.dataDir });
            } else {
                throw error;
            }
        }
    }

    /**
     * Garante que o arquivo de configuração existe
     */
    async ensureConfigFile() {
        try {
            await fs.access(this.filePath);
        } catch (error) {
            if (error.code === 'ENOENT') {
                const initialData = {
                    version: '1.0.0',
                    lastUpdated: new Date().toISOString(),
                    queues: {}
                };
                await fs.writeFile(this.filePath, JSON.stringify(initialData, null, 2));
                logger.info('Created initial configuration file', { filePath: this.filePath });
            } else {
                throw error;
            }
        }
    }

    /**
     * Salva a configuração de uma fila
     */
    async saveQueueConfig(queueName, config) {
        if (!this.isReady) {
            throw new Error('Persistence service not ready');
        }

        try {
            const data = await this.loadData();
            
            data.queues[queueName] = {
                ...config,
                savedAt: new Date().toISOString()
            };
            
            data.lastUpdated = new Date().toISOString();
            
            await this.saveData(data);
            
            logger.info('Queue configuration saved', { 
                queue: queueName,
                webhook: config.webhook 
            });
            
        } catch (error) {
            logger.error('Failed to save queue configuration', error, { queue: queueName });
            throw error;
        }
    }

    /**
     * Remove a configuração de uma fila
     */
    async removeQueueConfig(queueName) {
        if (!this.isReady) {
            throw new Error('Persistence service not ready');
        }

        try {
            const data = await this.loadData();
            
            if (data.queues[queueName]) {
                delete data.queues[queueName];
                data.lastUpdated = new Date().toISOString();
                
                await this.saveData(data);
                
                logger.info('Queue configuration removed', { queue: queueName });
                return true;
            }
            
            return false;
            
        } catch (error) {
            logger.error('Failed to remove queue configuration', error, { queue: queueName });
            throw error;
        }
    }

    /**
     * Carrega todas as configurações de filas salvas
     */
    async loadQueueConfigs() {
        if (!this.isReady) {
            throw new Error('Persistence service not ready');
        }

        try {
            const data = await this.loadData();
            return data.queues || {};
            
        } catch (error) {
            logger.error('Failed to load queue configurations', error);
            throw error;
        }
    }

    /**
     * Carrega a configuração de uma fila específica
     */
    async loadQueueConfig(queueName) {
        if (!this.isReady) {
            throw new Error('Persistence service not ready');
        }

        try {
            const configs = await this.loadQueueConfigs();
            return configs[queueName] || null;
            
        } catch (error) {
            logger.error('Failed to load queue configuration', error, { queue: queueName });
            throw error;
        }
    }

    /**
     * Verifica se uma fila tem configuração salva
     */
    async hasQueueConfig(queueName) {
        try {
            const config = await this.loadQueueConfig(queueName);
            return config !== null;
            
        } catch (error) {
            return false;
        }
    }

    /**
     * Obtém estatísticas das configurações salvas
     */
    async getStats() {
        try {
            const data = await this.loadData();
            const queueNames = Object.keys(data.queues || {});
            
            return {
                totalQueues: queueNames.length,
                queues: queueNames,
                lastUpdated: data.lastUpdated,
                version: data.version,
                filePath: this.filePath,
                fileSize: await this.getFileSize()
            };
            
        } catch (error) {
            logger.error('Failed to get persistence stats', error);
            return {
                totalQueues: 0,
                queues: [],
                lastUpdated: null,
                version: null,
                filePath: this.filePath,
                fileSize: 0,
                error: error.message
            };
        }
    }

    /**
     * Cria um backup das configurações
     */
    async createBackup(backupPath) {
        try {
            const data = await this.loadData();
            const backupFile = backupPath || `${this.filePath}.backup.${Date.now()}.json`;
            
            await fs.writeFile(backupFile, JSON.stringify(data, null, 2));
            
            logger.info('Backup created successfully', { backupFile });
            return backupFile;
            
        } catch (error) {
            logger.error('Failed to create backup', error);
            throw error;
        }
    }

    /**
     * Restaura as configurações de um backup
     */
    async restoreFromBackup(backupPath) {
        try {
            const backupData = await fs.readFile(backupPath, 'utf8');
            const data = JSON.parse(backupData);
            
            // Validar estrutura básica
            if (!data.queues || typeof data.queues !== 'object') {
                throw new Error('Invalid backup file structure');
            }
            
            await this.saveData(data);
            
            logger.info('Configurations restored from backup', { 
                backupFile: backupPath,
                queues: Object.keys(data.queues).length 
            });
            
            return Object.keys(data.queues);
            
        } catch (error) {
            logger.error('Failed to restore from backup', error);
            throw error;
        }
    }

    /**
     * Limpa todas as configurações
     */
    async clearAll() {
        try {
            const data = {
                version: '1.0.0',
                lastUpdated: new Date().toISOString(),
                queues: {}
            };
            
            await this.saveData(data);
            
            logger.info('All queue configurations cleared');
            
        } catch (error) {
            logger.error('Failed to clear configurations', error);
            throw error;
        }
    }

    /**
     * Carrega dados do arquivo
     */
    async loadData() {
        try {
            const fileContent = await fs.readFile(this.filePath, 'utf8');
            return JSON.parse(fileContent);
            
        } catch (error) {
            if (error.code === 'ENOENT') {
                // Arquivo não existe, retornar estrutura vazia
                return {
                    version: '1.0.0',
                    lastUpdated: new Date().toISOString(),
                    queues: {}
                };
            }
            throw error;
        }
    }

    /**
     * Salva dados no arquivo
     */
    async saveData(data) {
        try {
            await fs.writeFile(this.filePath, JSON.stringify(data, null, 2));
            
        } catch (error) {
            throw error;
        }
    }

    /**
     * Obtém o tamanho do arquivo em bytes
     */
    async getFileSize() {
        try {
            const stats = await fs.stat(this.filePath);
            return stats.size;
            
        } catch (error) {
            return 0;
        }
    }
}

module.exports = PersistenceService; 