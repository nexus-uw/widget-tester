/* global __dirname: false */
/* global process: false */

(function (module) {
  "use strict";

  var express = require("express");
  var gulp = require("gulp");
  var rename = require("gulp-rename");
  var htmlreplace = require("gulp-html-replace");
  var spawn = require("spawn-cmd").spawn;
  var gutil = require("gulp-util");
  var webdriver_update = require("gulp-protractor").webdriver_update;
  var protractor = require("gulp-protractor").protractor;
  var path = require("path");
  var runSequence = require("run-sequence");
  var uuid = require("node-uuid");
  var fs = require("fs");
  var xml2js = require("xml2js");
  var async = require("async");
  var karma = require("gulp-karma");
  var _ = require("lodash");
  var https = require("https");
  var http = require("http");
  var key = fs.readFileSync(path.join(__dirname, "keys", "https-key.pem"));
  var cert = fs.readFileSync(path.join(__dirname, "keys", "https-cert.pem"));
  var e2ePort = process.env.E2E_PORT || 8099;
  var httpServer;

  var factory = {
    gulpTaskFactory: {
      webdriveUpdate: function () {
        return webdriver_update;
      },
      testServer: function (options) {
        options = options || {};
        return function () {
          var server = express();
          server.use(express.static(options.rootPath || "./"));
          var credentials = {key: key, cert: cert};
          var hServer;
          if(options.https) {
            hServer = https.createServer(credentials, server);
          }
          else {
            hServer = http.createServer(server);
          }
          httpServer = hServer.listen(options.port || e2ePort);
          return httpServer;
        };
      },
      testServerClose: function () {
        return function () {
          return httpServer.close();
        };
      },
      htmlE2E: function (options) {
        options = options || {};
        if (!options.hasOwnProperty("e2egadgets")) {
          options.e2egadgets = "../node_modules/widget-tester/gadget-mocks.js";
        }

        return function () {
          return gulp.src("./src/settings.html")
            .pipe(htmlreplace(options))
            .pipe(rename(function (path) {
              path.basename += "-e2e";
            }))
            .pipe(gulp.dest("./src/"));
        };
      },
      testE2E: function (options) {
        options = options || {};

        var runCasperTests = function (cb) {
          var glob = require("glob");

          // options is optional
          glob(options.testFiles || "test/e2e/*.js", {}, function (er, files) {

            var casperChild = spawn(
              "casperjs",
              ["--xunit=" +
                path.resolve("reports", "casper-xunit.xml")].concat(["test"]).concat(files));

            casperChild.stdout.on("data", function (data) {
                gutil.log("CasperJS:", data.toString().slice(0, -1)); // Remove \n
            });

            casperChild.on("close", function (code) {
                var success = code === 0; // Will be 1 in the event of failure
                if(!success) {
                  cb("Error has occurred.");
                  throw code;
                }
                else {
                  cb();
                }
                // Do something with success here
            });
          });
        };

        var id = uuid.v1();
        gulp.task(id + ":ensureReportDirectory", factory.gulpTaskFactory.ensureReportDirectory());
        gulp.task(id + ":runCasperTests", runCasperTests);

        return function (cb) {
          runSequence(
            id + ":ensureReportDirectory",
            id + ":runCasperTests", cb
          );
        };
      },
      ensureReportDirectory: function (options) {
        options = options || {};
        return function (cb) {
          if(!fs.existsSync("./reports")) {
            fs.mkdir("./reports/", function (err) {
              cb(err);
            });
          }
          else {
            cb();
          }
        };
      },
      testUnitAngular: function (options) {
        options = options || {};
        return function(cb) {
          // Be sure to return the stream
          if(!options.testFiles) {
            cb("Test files is missing.");
          }
          else {
            return gulp.src(options.testFiles).pipe(
              karma({
                  configFile: options.configFile || path.join(__dirname, "karma.conf.js"),
                  action: options.watch ? "watch" : "run",
                  basePath : options.configFile || "./",
                })
              ).on("error", function(err) {
                // Make sure failed tests cause gulp to exit non-zero
                gutil.log("Error: ", err);
                cb(err);
                // throw err;
              });
          }
        };
      },
      testE2EAngular: function (options) {
        options = options || {};

        var runAngularTest = function (cb) {

          var args = ["--baseUrl", options.baseUrl || "http://127.0.0.1:" + e2ePort + "/src/settings-e2e.html"];

          var argv = require("yargs").argv;
          if(!options.specs && argv.specs) {
            options.specs = argv.specs;
          }

          return gulp.src(options.src || options.testFiles || options.specs || ["./test/e2e/**/*scenarios.js"])
            .pipe(protractor({
                configFile: options.configFile || path.join(__dirname, "protractor.conf.js"),
                args: args
            }))
            .on("error", function (e) {
              gutil.log(e);
              if(fs.statSync("./reports/angular-xunit.xml")) {
                //output test result to console
                gutil.log("Test report", fs.readFileSync("./reports/angular-xunit.xml", {encoding: "utf8"}));
              }
              if(options.throw || options.throw ===undefined) {
                throw e;
              }
              else {
                cb();
              }

            });
        };

        var id = uuid.v1();
        gulp.task(id + ":ensureReportDirectory", factory.gulpTaskFactory.ensureReportDirectory());
        gulp.task(id + ":runAngularTest", runAngularTest);

        return function (cb) {
          runSequence(
            id + ":ensureReportDirectory",
            id + ":runAngularTest", cb
          );
        };
      },
      metrics: function (options) {
        options = options || {};
        var generateMetrics = function(cb) {
          var glob = require("glob");

          // options is optional
          glob("reports/*xunit.xml", {}, function (er, files) {
            async.map(files, function (file, mapCallback) {
              var parser = new xml2js.Parser();
              gutil.log("Processing file", file, "...");
              parser.parseString(fs.readFileSync(file), function (err, result) {

                var results = [];

                var processTestSuite = function(testSuite) {
                  results.push({
                    tests: testSuite.$.tests,
                    failures: testSuite.$.failures,
                    errors: testSuite.$.errors,
                    skipped: testSuite.$.skipped
                  });
                };

                if(result.testsuites && result.testsuites.testsuite) {
                  result.testsuites.testsuite.forEach(processTestSuite);
                }
                else if (result.testsuite){
                  processTestSuite(result.testsuite);
                }
                mapCallback(err, results);
              });
            },
            function (err, results) {
              results = _.flatten(results);
              if(err) {cb(err); }
              else {
                async.reduce(results, {tests: 0, failures: 0, errors: 0, skipped: 0}, function (memo, item, callback){

                  callback(null, {
                    tests: memo.tests + (parseInt(item.tests) || 0),
                    failures: memo.failures + (parseInt(item.failures) || 0),
                    errors: memo.errors + (parseInt(item.errors) || 0),
                    skipped: memo.skipped + (parseInt(item.skipped) || 0)
                  });
                },
                function (err, result){
                  if(result) {
                    gutil.log("Aggregated metrics result:", result);
                    fs.writeFileSync("reports/metrics.json", JSON.stringify(result)); }
                    //save as Java .properties file to be picked up by Jenkins EnvInject Plugin
                    fs.writeFileSync("reports/metrics.json.properties",
                      require("properties").stringify({"CI_METRICS": JSON.stringify(result)}));
                  cb(err, result);
                });
              }
            });
          });
        };
        var id = uuid.v1();
        gulp.task(id + ":ensureReportDirectory", factory.gulpTaskFactory.ensureReportDirectory());
        gulp.task(id + ":generateMetrics", generateMetrics);

        return function (cb) {
          runSequence(
            id + ":ensureReportDirectory",
            id + ":generateMetrics", cb
          );
        };
      }
    }
  };

  module.exports = factory;

})(module);
