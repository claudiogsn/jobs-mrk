module.exports = {
    apps: [
        {
            name: "jobs-mrk",
            script: "server.js",
            out_file: "/var/log/jobs-mrk/stdout.log",
            error_file: "/var/log/jobs-mrk/stderr.log",
            log_date_format: "YYYY-MM-DD HH:mm:ss"
        }
    ]
}
