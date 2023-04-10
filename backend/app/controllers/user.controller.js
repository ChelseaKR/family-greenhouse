const crypto = require("crypto");
const { response } = require("express");
const AuthenticationClient = require('auth0').AuthenticationClient;
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
    console.log(req.body.greenhouseId);
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


// Find a single Plant with an id
exports.findOne = (req, res) => {
    const id = req.params.id;

    Plant.findByPk(id)
        .then(data => {
            res.send(data);
        })
        .catch(err => {
            res.status(500).send({
                message: "Error retrieving Plant with id=" + id
            });
        });
};

// Retrieve all Users from the database.
exports.findAll = (req, res) => {
    const greenhouseId = req.query.greenhouseId;

};

// Update a Plant by the id in the request
exports.update = (req, res) => {
    const id = req.params.id;

    Plant.update(req.body, {
        where: { id: id }
    })
        .then(num => {
            if (num == 1) {
                res.send({
                    message: "Plant was updated successfully."
                });
            } else {
                res.send({
                    message: `Cannot update Plant with id=${id}. Maybe Plant was not found or req.body is empty!`
                });
            }
        })
        .catch(err => {
            res.status(500).send({
                message: "Error updating Plant with id=" + id
            });
        });
};

// Delete a Plant with the specified id in the request
exports.delete = (req, res) => {
    const id = req.params.id;

    Plant.destroy({
        where: { id: id }
    })
        .then(num => {
            if (num == 1) {
                res.send({
                    message: "Plant was deleted successfully!"
                });
            } else {
                res.send({
                    message: `Cannot delete Plant with id=${id}. Maybe Plant was not found!`
                });
            }
        })
        .catch(err => {
            res.status(500).send({
                message: "Could not delete Plant with id=" + id
            });
        });
};

// Delete all Plants from the database.
exports.deleteAll = (req, res) => {
    Plant.destroy({
        where: {},
        truncate: false
    })
        .then(nums => {
            res.send({ message: `${nums} Plants were deleted successfully!` });
        })
        .catch(err => {
            res.status(500).send({
                message:
                    err.message || "Some error occurred while removing all Plants."
            });
        });
};