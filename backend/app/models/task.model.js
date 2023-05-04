module.exports = (sequelize, Sequelize) => {
    const Task = sequelize.define("task", {
        plant_id: {
            type: Sequelize.INTEGER
        },
        task_type: {
            type: Sequelize.STRING
        },
        task_frequency_days: {
            type: Sequelize.INTEGER
        },
        last_completed: {
            type: Sequelize.DATE
        },
        next_task_date: {
            type: Sequelize.DATEONLY
        },
        reminder_time: {
            type: Sequelize.TIME
        },
    });

    return Task;
};