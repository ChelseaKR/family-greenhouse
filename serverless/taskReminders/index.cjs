const dotenv = require('dotenv');
const axios = require('axios');
const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");
const { Pool } = require('pg');
const { ManagementClient } = require('auth0');
const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');

dotenv.config();
const now = new Date();

const auth0Domain = process.env.AUTH0_DOMAIN;
const clientId = process.env.AUTH0_CLIENTID;
const clientSecret = process.env.AUTH0_CLIENTSECRET;

const AWS_REGION="us-west-2";
const secretsManagerClient = new SecretsManagerClient({region: AWS_REGION});
const sesClient = new SESClient({ region: AWS_REGION });

exports.handler = async (event) => {
    const secretParams = {
        SecretId: 'arn:aws:secretsmanager:us-west-2:014248889144:secret:family-greenhouse/db/postgres-xMOkKx'
    };

    const auth0ManagementApiToken = await getManagementApiToken(auth0Domain, clientId, clientSecret);
    const result = await secretsManagerClient.send(new GetSecretValueCommand(secretParams));
    const secrets = JSON.parse(result.SecretString);
    const today = now.toISOString().slice(0, 10); // today's date in YYYY-MM-DD string

    const pool = new Pool({
        host: secrets.host,
        user: secrets.username,
        password: secrets.password,
        database: 'db_family_greenhouse',
        port: secrets.port
    });

    const selectQuery = {
        text: 'SELECT * FROM tasks t JOIN plants p ON t.plant_id = p.id WHERE t.next_task_date = CURRENT_DATE;',
    };

    try {
        const queryResult = await pool.query(selectQuery);
        const queryRows = queryResult.rows;

        for (let i=0; i < queryRows.length; i++) {
            const taskId = queryRows[i]["t.id"];
            const greenhouseId = queryRows[i]["greenhouse"];
            const plantName = queryRows[i]["name"];
            const plantType = queryRows[i]["type"];
            const plantLocation = queryRows[i]["location"];
            const taskType = queryRows[i]["task_type"];
            const taskFrequencyDays = queryRows[i]["watering_frequency_days"];
            const taskNextDate = queryRows[i]["next_task_date"].toISOString().slice(0, 10);
            const waterReminderTime = queryRows[i]["water_reminder_time"];
            const waterReminderTimeHours = Number(waterReminderTime.split(':')[0]);

            if (taskNextDate == today && waterReminderTimeHours == now.getHours()) {
                const emailAddresses = await getUsersByEmailWithGreenhouseId(auth0Domain, auth0ManagementApiToken, greenhouseId);
                const newTaskNextDate = new Date(today + taskFrequencyDays).getDate();
                const htmlBody = await generateEmailBody(taskType, plantName, plantType, plantLocation, taskNextDate);
                const subject = `Reminder to ${taskType} ${plantName}`;
                await sendEmail("DO-NOT-REPLY@familygreenhouse.net", emailAddresses, subject, htmlBody);

                const updateTaskQuery = {
                    text: 'UPDATE tasks SET next_task_date = $1, last_completed=$2 WHERE id = $3;',
                    values: [newTaskNextDate, new Date(), taskId]
                };

                try {
                    await pool.query(updateTaskQuery);
                } catch (err) {
                    console.error('Error executing task UPDATE query:', err);
                }

                const insertTaskEventQuery = {
                    text: 'INSERT INTO task_events VALUES ($1, $2, $3, $4, $5);',
                    values: [taskId, new Date(), false, null, null]
                };

                try {
                    await pool.query(insertTaskEventQuery);
                } catch (err) {
                    console.error('Error executing task event INSERT query:', err);
                }
            }
        }
    } catch (err) {
        console.error('Error executing SELECT query:', err);
    } finally {
        pool.end();
    }
};

async function getManagementApiToken(auth0Domain, clientId, clientSecret) {
    try {
        const url = `https://${auth0Domain}/oauth/token`;
        const headers = {
            'Content-Type': 'application/json',
        };
        const body = {
            client_id: clientId,
            client_secret: clientSecret,
            audience: `https://${auth0Domain}/api/v2/`,
            grant_type: 'client_credentials',
        };

        const response = await axios.post(url, body, { headers });

        if (response && response.data && response.data.access_token) {
            return response.data.access_token;
        } else {
            throw new Error('Failed to obtain access token.');
        }
    } catch (error) {
        console.error('Error obtaining access token:', error);
        throw error;
    }
}

async function getUsersByEmailWithGreenhouseId(auth0Domain, managementApiToken, greenhouseId) {
    const auth0Client = new ManagementClient({
        domain: auth0Domain,
        token: managementApiToken,
    });

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

async function generateEmailBody(taskType, plantName, plantType, plantLocation, taskNextDate) {
    const htmlBody = `
      <html>
        <head></head>
        <body>
          <h1>Hello from <a href="https://familygreenhouse.net/">Family Greenhouse!</a></h1>
          <p>
              This is a reminder to ${taskType} ${plantName}, the ${plantType} in your ${plantLocation}. Your next
               reminder to ${taskType} ${plantName} will occur on ${taskNextDate}.
          </p>
          <p>
              To change settings for these reminders, please change your plant's settings in
               <a href="https://familygreenhouse.net/">Family Greenhouse.</a>
          </p>
        </body>
      </html>
    `;

    return htmlBody;
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