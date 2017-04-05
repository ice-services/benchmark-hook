"use strict";

const express 		= require("express");
const fs 			= require("fs");
const path 			= require("path");
const http 			= require("http");
const bodyParser	= require("body-parser");
const mkdir			= require("mkdirp");

const Handlebars	= require("handlebars");
const GitHubApi		= require("github");
const git 			= require("nodegit");
const exeq 			= require("exeq");
const del 			= require("del");

const github = new GitHubApi({
	debug: false
});

const REPO_OWNER = "icebob";
const REPO_NAME = "benchmark-hook-example";

github.authenticate({
	type: "token",
	token: "78d77350f6b761a2118d6f3435365600f13437d9"
});


// Create express app
const app = express();

app.set("showStackError", true);

app.use(bodyParser.urlencoded({
	extended: true
}));

app.use(bodyParser.json());	

app.post("/github-hook", (req, res) => {
	//console.log(req.headers);

	const event = req.headers["x-github-event"];
	if (event == "pull_request") {
		processPullRequest(req.body, req.headers);
	}
	else if (event == "push") {
		processPush(req.body, req.headers);
	}

	res.sendStatus(200);
});

const port = 4278;
app.listen(port, function() {
	console.log("Developer server running on http://localhost:" + port);
});

function processPullRequest(payload) {
	console.log("PR event!");
	const prNumber = payload.number;
	if (payload.action == "opened") {
		console.log(`New PR opened! ID: ${prNumber}, Name: ${payload.pull_request.title}`);

		const headGitUrl = payload.pull_request.head.repo.clone_url; // PR repo-ja
		const baseGitUrl = payload.repository.clone_url; // Alap master repo

		console.log("Master: " + baseGitUrl);
		console.log("PR: " + headGitUrl);

		let workID = Math.random().toString(36).replace(/[^a-z]+/g, '');
		console.log("Work ID: " + workID);

		let folder = "./tmp/" + workID;
		mkdir.sync(folder);

		let masterFolder = path.join(folder, "master");
		mkdir.sync(masterFolder);

		let prFolder = path.join(folder, "pr");
		mkdir.sync(prFolder);

		runBenchmark(baseGitUrl, "npm run bench", masterFolder).then(masterResult => {
			return runBenchmark(headGitUrl, "npm run bench", prFolder).then(prResult => {
				return compareResults(masterResult, prResult);
			});
		})
		.then(compared => {
			console.log("Compare result:", compared);

			// Create comment on PR
			addCommentToPR(prNumber, compared);
		})
		.then(() => {
			// Delete tmp folder
			return del([folder]);
		})
		.then(() => {
			console.log("Done!");
		})
		.catch(err => console.error(err));
	}
}

function processPush(payload) {
	console.log("Push event!");
}

function runBenchmark(gitUrl, command, folder) {
	return Promise.resolve()
		.then(() => git.Clone(gitUrl, folder))
		.then(repo => {
			return exeq("cd " + folder, "npm i", command)
				.then(msgs => {
					let result = fs.readFileSync(path.join(folder, "bench-results", "simple.json"), "utf8");
					return JSON.parse(result);
				})
		});
}

function formatNum(num, decimals = 2, addSign = false) {
	let res = Number(num.toFixed(decimals)).toLocaleString();
	if (addSign && num > 0.0)
		res = "+" + res;
	return res;
}

function compareResults(masterResult, prResult) {
	let compared = {};

	Object.keys(masterResult.suites).forEach(suiteName => {
		const masterSuite = masterResult.suites[suiteName];
		const prSuite = prResult.suites[suiteName];
		if (masterSuite && prSuite) {

			compared[suiteName] = masterSuite.map((masterTest) => {
				const testName = masterTest.name;
				const masterCount = masterTest.count;

				const prTest = prSuite.find(item => item.name == testName);
				if (prTest) {
					const prCount = prTest.count;
					const percent = ((prCount - masterCount) * 100.0) / masterCount;
					const percentage = formatNum(percent, 0, true)

					return {
						name: testName,
						masterCount: formatNum(masterCount),
						prCount: formatNum(prCount),
						diff: formatNum(prCount - masterCount, 2, true),
						percentage,
						badge: `https://img.shields.io/badge/performance-${percentage.replace('-', '--')}%25-${getBadgeColor(percent)}.svg`
					}
				}
			});


		} else {
			console.warn(`'${suiteName}' suite not defined both results!`);
		}
	});

	return Promise.resolve(compared);
}

function getBadgeColor(value) {
	if (value > 20) return "brightgreen";
	if (value > 5) return "green";
	if (value < 5) return "orange";
	if (value < 20) return "red";

	return "yellow";
}

const commentTemplate = Handlebars.compile(`
## Benchmark results

{{#each this}}
### Suite: {{@key}}

| Test | Master (ops/sec) | PR (ops/sec) | Diff (ops/sec) |
| ------- | ----- | ------- | ------- |
{{#each this}}
|**{{name}}**| \`{{masterCount}}\` | \`{{prCount}}\` | \`{{diff}}\` ![Performance: {{percentage}}%]({{badge}}) |
{{/each}}

{{/each}}
`);

function addCommentToPR(number, result) {
	return github.issues.createComment({
		owner: REPO_OWNER,
		repo: REPO_NAME,
		number,
		body: commentTemplate(result)
	});
}
