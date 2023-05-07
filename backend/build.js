const childProcess = require("child_process");

try {
    childProcess.exec("npm run build");
} catch (err) {
    console.log(err);
}
