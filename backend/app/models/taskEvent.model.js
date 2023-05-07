module.exports = (sequelize, Sequelize) => {
    const TaskEvent = sequelize.define("task_event", {
        task_id: {
            type: Sequelize.INTEGER
        },
        datetime: {
            type: Sequelize.DATE
        },
        is_completed: {
            type: Sequelize.BOOLEAN
        },
        completed_by: {
            type: Sequelize.STRING
        },
        completed_on: {
            type: Sequelize.DATE
        }
    });

    return TaskEvent;
};