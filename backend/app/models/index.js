const Sequelize = require("sequelize");
const dbConfig = require("../config/db.config.js");


const sequelize = new Sequelize(dbConfig.DB, dbConfig.USER, dbConfig.PASSWORD, {
    host: dbConfig.HOST,
    dialect: "postgres",
    operatorsAliases: false,

    pool: {
        max: dbConfig.pool.max,
        min: dbConfig.pool.min,
        acquire: dbConfig.pool.acquire,
        idle: dbConfig.pool.idle
    }
});

const Plant = require('./plant.model')(sequelize, Sequelize);
const Task = require('./task.model')(sequelize, Sequelize);
const TaskEvent = require('./taskEvent.model')(sequelize, Sequelize);


Plant.hasMany(Task, { as: 'task', foreignKey: 'id' });
Task.belongsTo(Plant, { as: 'plant', foreignKey: 'plant_id' });
TaskEvent.belongsTo(Task, {as: 'task', foreignKey: 'task_id' });

const db = {};

db.Sequelize = Sequelize;
db.sequelize = sequelize;

db.plants = require("./plant.model.js")(sequelize, Sequelize);
db.tasks = require("./task.model.js")(sequelize, Sequelize);
db.tasks = require("./taskEvent.model.js")(sequelize, Sequelize);

module.exports = db;
