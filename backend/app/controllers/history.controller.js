const db = require("../models");
const History = db.events;
const { plants: Plant, tasks: Task, events: Event } = db;

// Retrieve all History from the database by greenhouse
exports.findAll = (req, res) => {
    const greenhouse = req.query.greenhouse;
    Event.findAll({
        include: [
            {
                model: Task,
                as: "task",
                include: [
                    {
                        model: Plant,
                        as: "plant",
                        where: { greenhouse: greenhouse },
                    },
                ],
            },
        ],
    })
    .then((data) => {
        res.send(data);
    })
    .catch((err) => {
        res.status(500).send({
            message: err.message || "Some error occurred while retrieving Histories.",
        });
    });
};
/*
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
*/
