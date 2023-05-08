module.exports = app => {
    const users = require("../controllers/user.controller.js");

    var router = require("express").Router();

    router.post("/add", users.create);

    router.get("/", users.findAll);

    router.get("/:id", users.findOne);

    router.delete("/:id", users.delete);

    router.get("/:greenhouseId", users.findAll);

    app.use("/api/users", router);
};
