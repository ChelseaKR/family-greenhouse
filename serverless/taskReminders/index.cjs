const { dotenv } = require('dotenv');
const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");
const { Pool } = require('pg');
const { Auth0Client } = require('auth0');
const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');

const auth0Client = new Auth0Client({
    domain: auth0Domain,
    token: managementApiToken,
});

const AWS_REGION="us-wes-2";
const secretsManagerClient = new SecretsManagerClient({region: AWS_REGION});
const sesClient = new SESClient({ region: AWS_REGION });

const htmlBody = `
  <html>
    <head></head>
    <body>
      <h1>Hello World!</h1>
      <p>This is an HTML email sent with Amazon SES and AWS SDK for JavaScript.</p>
    </body>
  </html>
`;

exports.handler = async (event) => {
    dotenv.config();
    const secretParams = {
        SecretId: 'arn:aws:secretsmanager:us-west-2:014248889144:secret:family-greenhouse/db/postgres-xMOkKx'
    };

    const result = await secretsManagerClient.send(new GetSecretValueCommand(secretParams));
    const secrets = JSON.parse(result.SecretString);
    const today = new Date().getDate();

    const pool = new Pool({
        host: secrets.host,
        user: secrets.username,
        password: secrets.password,
        database: 'db_family_greenhouse',
        port: secrets.port
    });

    const query = {
        text: 'SELECT * FROM tasks t JOIN plants p ON t.plant_id = p.id WHERE t.next_task_date = $1;', // TODO: FILTER BY REMINDER TIME AS WELL
        values: [new Date().getDate()]
    };

    try {
        const queryResult = await pool.query(query);
        const queryRows = queryResult.rows;

        for (let i=0; i < queryRows.length(); i++) {
            const plantId = queryRows["plant_id"];
            const greenhouseId = queryRows["greenhouse"];
            const taskType = queryRows["task_type"];
            const taskFrequencyDays = queryRows["watering_frequency_days"];
            const taskNextDate = queryRows["t.next_task_date"];
            // const taskNextDate = new Date(today + taskFrequencyDays);
            const taskLastCompleted = queryRows["t.last_completed"];

            if (taskNextDate == today) {
                const emailAddresses = await getUsersByEmailWithGreenhouseId(greenhouseId);
                await sendEmail("DO-NOT-REPLY@familygreenhouse.net", emailAddresses, "Subject", htmlBody);

                // update task record
            }

        }
    } catch (err) {
        console.error('Error executing query:', err);
    } finally {
        pool.end();
    }
};

async function getUsersByEmailWithGreenhouseId(greenhouseId) {
    try {
        const searchQuery = `user_metadata.greenhouse:"${greenhouseId}"`;
        const users = await auth0Client.getUsers({ q: searchQuery, search_engine: 'v3' });

        if (users && users.length > 0) {
            const userEmails = users.map((user) => user.email);
            return userEmails;
        } else {
            console.log(`No users found with greenhouseId "${greenhouseId}".`);
            return [];
        }
    } catch (error) {
        console.error('Error retrieving users by metadata:', error);
        return [];
    }
}

async function sendEmail(fromEmail, toEmails, subject, htmlBody) {
    try {
        const params = {
            Source: fromEmail,
            Destination: {
                ToAddresses: toEmails,
            },
            Message: {
                Subject: {
                    Data: subject,
                },
                Body: {
                    Html: {
                        Data: htmlBody,
                    },
                },
            },
        };

        const command = new SendEmailCommand(params);
        const response = await sesClient.send(command);
        console.log('Email sent successfully:', response);
    } catch (error) {
        console.error('Error sending email:', error);
    }
}