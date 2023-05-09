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
const Event = require('./event.model')(sequelize, Sequelize);



const db = {};

db.Sequelize = Sequelize;
db.sequelize = sequelize;

db.plants = Plant;
db.tasks = Task;
db.events = Event;

db.plants.hasMany(db.tasks, { foreignKey: 'plant_id' });
db.tasks.belongsTo(db.plants, { foreignKey: 'plant_id' });
db.tasks.hasMany(db.events, { foreignKey: 'task_id' });
db.events.belongsTo(db.tasks, { foreignKey: 'task_id' });

module.exports = db;
