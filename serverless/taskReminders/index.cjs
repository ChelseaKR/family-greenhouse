const SecretsManagerClient = require("@aws-sdk/client-secrets-manager").SecretsManagerClient;
const GetSecretValueCommand = require("@aws-sdk/client-secrets-manager").GetSecretValueCommand;
const pkg = require('pg');


exports.handler = async (event) => {
    const Pool = pkg.Pool;

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
        const fin = JSON.stringify(secrets);
        console.log(JSON.stringify(secrets))
        // const rdsParams = {
        //   DBInstanceIdentifier: secrets.rdsInstanceIdentifier,
        //   MasterUsername: secrets.rdsUsername,
        //   MasterUserPassword: secrets.rdsPassword
        // };

        // const rdsResult = await rds.describeDBInstances(rdsParams).promise();
        // const dbEndpoint = rdsResult.DBInstances[0].Endpoint;

        // const pool = new Pool({
        //   host: dbEndpoint.Address,
        //   user: secrets.rdsUsername,
        //   password: secrets.rdsPassword,
        //   database: secrets.rdsDatabaseName,
        //   port: dbEndpoint.Port
        // });

        // const query = {
        //   text: 'SELECT * FROM tasks t WHERE t.next_task_date = $1 AND t.task_type = $2',
        //   values: [new Date(), 'water']
        // };

        // const result = await pool.query(query);
        // console.log('SQL results: ', result.rows);
        // // do something with the results
        // pool.end();
};
