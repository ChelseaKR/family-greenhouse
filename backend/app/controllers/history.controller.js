const db = require("../models");
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
            message: err.message || "Some error occurred while retrieving history.",
        });
    });
};

// Update an Event by the id in the request
exports.update = (req, res) => {
    const id = req.params.id;

    console.log('Updating event with ID:', id);
    console.log('Request body:', req.body);

    Event.update(req.body, {
        where: { id: id }
    })
        .then(num => {
            console.log('Update result:', num);

            if (num == 1) {
                res.send({
                    message: "Event was updated successfully."
                });
            } else {
                res.send({
                    message: `Cannot update Event with id=${id}. Event was not found or req.body is empty!`
                });
            }
        })
        .catch(err => {
            console.error('Error updating event:', err);
            res.status(500).send({
                message: "Error updating Event with id=" + id
            });
        });
};

// Delete a history item with the specified id in the request
exports.delete = (req, res) => {
    const id = req.params.id;

    Event.destroy({
        where: { id: id }
    })
        .then(num => {
            if (num == 1) {
                res.send({
                    message: "Event was deleted successfully!"
                });
            } else {
                res.send({
                    message: `Cannot delete Event with id=${id}. Event was not found!`
                });
            }
        })
        .catch(err => {
            res.status(500).send({
                message: "Could not delete event with id=" + id
            });
        });
};