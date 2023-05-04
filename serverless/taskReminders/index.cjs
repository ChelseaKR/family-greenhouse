const SecretsManagerClient = require("@aws-sdk/client-secrets-manager").SecretsManagerClient;
const GetSecretValueCommand = require("@aws-sdk/client-secrets-manager").GetSecretValueCommand;
const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');
const { Pool } = require('pg');
const { Auth0 } = require('auth0');

exports.handler = async (event) => {
    const secretsManager = new SecretsManagerClient({
        region: "us-west-2",
    });

    const secretParams = {
        SecretId: 'arn:aws:secretsmanager:us-west-2:014248889144:secret:family-greenhouse/db/postgres-xMOkKx'
    };

    const result = await secretsManager.send(
        new GetSecretValueCommand(secretParams)
    );
    const secrets = JSON.parse(result.SecretString);
    console.log(JSON.stringify(secrets))

    const pool = new Pool({
        host: secrets.host,
        user: secrets.username,
        password: secrets.password,
        database: 'db_family_greenhouse',
        port: secrets.port
    });
    const query = {
        text: 'SELECT * FROM tasks t JOIN plants p ON t.plants_id = p.id WHERE t.next_task_date = $1;', // TODO: FILTER BY REMINDER TIME AS WELL
        values: [new Date().getDate()]
    };

    try {
        const queryResult = await pool.query(query);
        const queryRows = queryResult.rows;

        for (let i=0; i < queryRows.length(); i++) {
            const plantId = queryRows["plant_id"];
            const taskFrequencyDays = queryRows["watering_frequency_days"];
            const today = new Date().getDate();
            const next_task_date = new Date(today + taskFrequencyDays);


        }
    } catch (err) {
        console.error('Error executing query:', err);
    } finally {
        pool.end();
    }
};