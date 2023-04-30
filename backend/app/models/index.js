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
const Plant = require('./plant')(sequelize, Sequelize);
const Task = require('./task')(sequelize, Sequelize);

Plant.hasMany(Task, { as: 'tasks', foreignKey: 'plant_id' });
Task.belongsTo(Plant, { as: 'plant', foreignKey: 'id' });

const db = {};

db.Sequelize = Sequelize;
db.sequelize = sequelize;

db.plants = require("./plant.model.js")(sequelize, Sequelize);
db.tasks = require("./tasks.model.js")(sequelize, Sequelize);

module.exports = db;
