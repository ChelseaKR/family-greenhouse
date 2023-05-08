const db = require("../models");
const Plant = db.plants;
const Task = db.tasks;
const Op = db.Sequelize.Op;

// Create and Save a new Plant
exports.create = async (req, res) => {
    // Validate request
    if (!req.body.userId || !req.body.greenhouse) {
        res.status(400).send({
            message: "user id or greenhouse can't be empty!"
        });
        return;
    }
    // Create a Plant
    const plant = {
        userId: req.body.userId,
        greenhouse: req.body.greenhouse,
        name: req.body.name,
        type: req.body.type,
        location: req.body.location,
        description: req.body.description,
        water_frequency_days: req.body.water_frequency_days,
        water_reminder_time: '12:00:00',
    };

    try {
        // Save Plant in the database
        const createdPlant = await Plant.create(plant);

        // Create a Task associated with the created Plant
        const task = {
            plant_id: createdPlant.id,
            task_type: 'water',
            last_completed: req.body.last_completed,
            next_task_date: new Date(new Date().getTime() + createdPlant.water_frequency_days * 24 * 60 * 60 * 1000)
        };

        try {
            // Save Task in the database
            const createdTask = await Task.create(task);
            res.send({ plant: createdPlant, task: createdTask });

        } catch (err) {
            res.status(500).send({
                message: err.message || "Some error occurred while creating the plant and task."
            })
        }

    } catch (err) {
        res.status(500).send({
            message: err.message || "Some error occurred while creating the plant and task."
        });
    }
};

// Retrieve all Plants from the database.
exports.findAll = (req, res) => {
    const greenhouse = req.query.greenhouse;
    const name = req.query.name;
    let whereClause = null;
    if (greenhouse != null && name != null) {
        whereClause = { greenhouse: { [Op.eq]: greenhouse }, name: { [Op.iLike]: `%${name}%` } };
    } else if (greenhouse != null && name == null) {
        whereClause = { greenhouse: { [Op.eq]: greenhouse }};
    }

    if (whereClause != null) {
        Plant.findAll({ where: whereClause })
            .then(data => {
                res.send(data);
            })
            .catch(err => {
                res.status(500).send({
                    message:
                        err.message || "Some error occurred while retrieving Plants."
                });
            });
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