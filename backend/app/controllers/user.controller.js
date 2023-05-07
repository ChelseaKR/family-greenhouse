const ManagementClient = require('auth0').ManagementClient;

const auth0Management = new ManagementClient({
    domain: process.env.AUTH0_DOMAIN,
    clientId: process.env.AUTH0_CLIENTID,
    clientSecret: process.env.AUTH0_CLIENTSECRET,
    scope: 'create:users read:users update:users',
});

// Create a new user in the user's greenhouse
exports.create = (req, res) => {
    // Validate request
    if (!req.body.greenhouseId || !req.body.email) {
        res.status(400).send({
            message: "user id or email can't be empty!"
        });
        return;
    }

    function generateRandomString(length) {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()_+{}[];,./|\\:"<>?';
        let result = '';
        for (let i = 0; i < length; i++) {
            result += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return result;
    }

    // Create a user
    const metadata = {'greenhouse': req.body.greenhouseId};
    const options = {
        email: req.body.email,
        user_metadata: metadata,
        password: generateRandomString(16),
        connection: 'Username-Password-Authentication',
        verify_email: true,
    };

    try {
        const user = auth0Management.createUser(options);
    } catch (error) {
        console.error(error);
    }
};


// Find a single User with an id
exports.findOne = (req, res) => {
    const id = req.body.id;

};

// Retrieve all Users from the database.
exports.findAll = (req, res) => {
    const greenhouseId = req.query.greenhouseId;
    // Create a user
    const metadata = {'greenhouse': req.body.greenhouseId};

    try {
    } catch (error) {
        console.error(error);
    }
};

// Delete a User with the specified id in the request
exports.delete = (req, res) => {
    const id = req.params.id;
};