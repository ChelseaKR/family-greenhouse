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
            message: err.message || "Some error occurred while retrieving history.",
        });
    });
};