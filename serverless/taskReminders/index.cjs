const SecretsManagerClient = require("@aws-sdk/client-secrets-manager").SecretsManagerClient;
const GetSecretValueCommand = require("@aws-sdk/client-secrets-manager").GetSecretValueCommand;

//const { RDSClient, DescribeDBInstancesCommand } = require("@aws-sdk/client-rds");
const RDSClient = require("@aws-sdk/client-rds").RDSClient;
const DescribeDBInstancesCommand = require("@aws-sdk/client-rds").DescribeDBInstancesCommand;
const { Client, Pool } = require('pg');

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
        database: secrets.dbInstanceIdentifier,
        port: secrets.port
    });
    const query = {
        text: 'SELECT * FROM tasks t WHERE t.next_task_date = $1 AND t.task_type = $2',
        values: [new Date().getDate(), 'water']
    };

    try {

        const queryResult = pool.query(query);
        console.log("HELLO");

        console.log('SQL results: ', queryResult.rows);
        // do something with the results
    } catch (err) {
        console.error('Error executing query:', err);
    } finally {
        pool.end();
    }
};