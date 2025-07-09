/**
 * Exemplo de uso das funcionalidades de persistência
 * 
 * Este script demonstra como:
 * 1. Iniciar consumo de filas
 * 2. Verificar configurações salvas
 * 3. Criar backups
 * 4. Restaurar configurações
 */

const axios = require('axios');

// Configuração da API
const API_BASE = 'http://localhost:3000';

// Cliente HTTP pré-configurado
const api = axios.create({
    baseURL: API_BASE,
    timeout: 10000,
    headers: {
        'Content-Type': 'application/json'
    }
});

// Função para log das operações
function log(operation, data = null) {
    console.log(`\n🔄 ${operation}`);
    if (data) {
        console.log(JSON.stringify(data, null, 2));
    }
}

// Função para esperar um tempo
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
    try {
        console.log('🚀 Exemplo de Persistência Automática - RabbitMQ Consumer API v2.0\n');

        // 1. Verificar status da aplicação
        log('Verificando status da aplicação...');
        const healthResponse = await api.get('/health');
        console.log(`Status: ${healthResponse.data.status}`);

        // 2. Verificar configurações salvas existentes
        log('Verificando configurações salvas...');
        const persistedResponse = await api.get('/persisted-queues');
        console.log(`Filas salvas: ${persistedResponse.data.stats.totalQueues}`);
        if (persistedResponse.data.stats.totalQueues > 0) {
            console.log('Configurações existentes:', persistedResponse.data.persisted);
        }

        // 3. Iniciar consumo de algumas filas (que serão automaticamente salvas)
        log('Iniciando consumo de filas (serão salvas automaticamente)...');
        
        const queues = [
            {
                queue: 'orders',
                webhook: 'https://httpbin.org/post',
                minInterval: 30000,
                maxInterval: 60000,
                businessHours: { start: 8, end: 18 }
            },
            {
                queue: 'notifications',
                webhook: 'https://httpbin.org/post',
                minInterval: 15000,
                maxInterval: 45000,
                businessHours: { start: 0, end: 24 }
            }
        ];

        for (const queueConfig of queues) {
            try {
                const response = await api.post('/consume', queueConfig);
                console.log(`✅ Fila "${queueConfig.queue}" iniciada e salva automaticamente`);
            } catch (error) {
                console.log(`⚠️ Erro ao iniciar fila "${queueConfig.queue}": ${error.response?.data?.error || error.message}`);
            }
        }

        // 4. Aguardar um pouco e verificar filas ativas
        await sleep(2000);
        log('Verificando filas ativas...');
        const activeResponse = await api.get('/active-queues');
        console.log(`Filas ativas: ${activeResponse.data.count}`);

        // 5. Verificar configurações salvas novamente
        await sleep(1000);
        log('Verificando configurações salvas após iniciar consumo...');
        const updatedPersistedResponse = await api.get('/persisted-queues');
        console.log(`Filas salvas: ${updatedPersistedResponse.data.stats.totalQueues}`);
        console.log('Configurações salvas:', Object.keys(updatedPersistedResponse.data.persisted));

        // 6. Criar backup das configurações
        log('Criando backup das configurações...');
        const backupResponse = await api.post('/backup-configs', {
            path: './examples/backup-example.json'
        });
        console.log(`Backup criado: ${backupResponse.data.backupFile}`);

        // 7. Demonstrar parada manual de uma fila (remove da persistência)
        log('Parando uma fila manualmente (será removida da persistência)...');
        try {
            await api.post('/stop', { queue: 'notifications' });
            console.log('✅ Fila "notifications" parada manualmente');
        } catch (error) {
            console.log(`⚠️ Erro ao parar fila: ${error.response?.data?.error || error.message}`);
        }

        // 8. Verificar configurações após parada manual
        await sleep(1000);
        log('Verificando configurações após parada manual...');
        const afterStopResponse = await api.get('/persisted-queues');
        console.log(`Filas salvas: ${afterStopResponse.data.stats.totalQueues}`);
        console.log('Configurações restantes:', Object.keys(afterStopResponse.data.persisted));

        // 9. Restaurar manualmente as filas salvas
        log('Restaurando manualmente as filas salvas...');
        const restoreResponse = await api.post('/restore-queues');
        console.log('Resultado da restauração:', restoreResponse.data.result);

        // 10. Verificar estatísticas finais
        await sleep(1000);
        log('Estatísticas finais...');
        const statsResponse = await api.get('/stats');
        console.log(`Consumers ativos: ${statsResponse.data.activeConsumers}`);
        console.log(`Persistência habilitada: ${statsResponse.data.persistence}`);

        console.log('\n✅ Exemplo concluído com sucesso!');
        console.log('\n💡 Para testar a persistência automática:');
        console.log('   1. Reinicie a aplicação');
        console.log('   2. As filas salvas serão automaticamente restauradas');
        console.log('   3. Use GET /active-queues para verificar');
        console.log('\n🛡️ Sistema robusto contra filas deletadas externamente:');
        console.log('   - Se você deletar uma fila diretamente no RabbitMQ');
        console.log('   - O sistema detecta automaticamente e limpa a configuração');
        console.log('   - Outras filas continuam funcionando normalmente');
        console.log('   - Não é necessária intervenção manual');

    } catch (error) {
        console.error('\n❌ Erro durante execução:', error.response?.data || error.message);
        console.error('\n💡 Certifique-se de que:');
        console.error('   - A aplicação está rodando em http://localhost:3000');
        console.error('   - O RabbitMQ está acessível');
        console.error('   - As filas existem no RabbitMQ');
    }
}

// Executar exemplo
if (require.main === module) {
    main().catch(console.error);
}

module.exports = { main }; 