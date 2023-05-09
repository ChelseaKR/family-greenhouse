module.exports = (sequelize, Sequelize) => {
    const Task = sequelize.define("task", {
        id: {
            type: Sequelize.INTEGER,
            primaryKey: true,
            autoIncrement: true,
        },
        plant_id: {
            type: Sequelize.INTEGER
        },
        task_type: {
            type: Sequelize.STRING
        },
        last_completed: {
            type: Sequelize.DATE
        },
        next_task_date: {
            type: Sequelize.DATEONLY
        }
    });

    return Task;
};