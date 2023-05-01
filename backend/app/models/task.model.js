module.exports = (sequelize, Sequelize) => {
    const Task = sequelize.define("task", {
        task_type: {
            type: Sequelize.STRING
        },
        reminder_time: {
            type: Sequelize.TIME
        },
        next_task_date: {
            type: Sequelize.DATEONLY
        }
    });

    return Task;
};