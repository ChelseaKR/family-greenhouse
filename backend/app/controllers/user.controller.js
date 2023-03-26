// Create a new user in the user's greenhouse
exports.create = (req, res) => {
    // Validate request
    if (!req.body.greenhouseId || !req.body.email) {
        res.status(400).send({
            message: "user id or email can't be empty!"
        });
        return;
    }

    // Create a user
    const plant = {
        email: req.body.email,
        greenhouseId: req.body.greenhouseId,
    };

    // TODO: Implement Auth0 create user call here, use greenhouseId in user user data
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