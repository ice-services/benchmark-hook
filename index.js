"use strict";

const express 		= require("express");
const fs 			= require("fs");
const path 			= require("path");
const http 			= require("http");
const bodyParser	= require("body-parser");
const mkdir			= require("mkdirp");

const Handlebars	= require("handlebars");
const GitHubApi		= require("github");
const exeq 			= require("exeq");
const del 			= require("del");

const { REPO_OWNER, REPO_NAME, SUITE_FILENAME } = process.env;

const github = new GitHubApi({
	debug: false
});

github.authenticate({
	type: "token",
	token: process.env.GITHUB_TOKEN
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
	if (["opened", "synchronize"].indexOf(payload.action) !== -1) {
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

		runBenchmark(baseGitUrl, masterFolder).then(masterResult => {
			return runBenchmark(headGitUrl, prFolder).then(prResult => {
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

function runBenchmark(gitUrl, folder) {
	return Promise.resolve()
		.then(() => {
			return exeq("git clone " + gitUrl + " " + folder, "cd " + folder, "npm i")
				.then(msgs => {
					return require(path.join(__dirname, folder, SUITE_FILENAME));
				})
		});
}

function formatNum(num, decimals = 0, addSign = false) {
	let res = Number(num.toFixed(decimals)).toLocaleString();
	if (addSign && num > 0.0)
		res = "+" + res;
	return res;
}

function compareResults(masterResult, prResult) {
	let compared = [];

	masterResult.forEach(masterSuite => {
		const prSuite = prResult.find(item => item.name == masterSuite.name);
		if (masterSuite && prSuite) {

			compared.push({
				name: masterSuite.name,
				tests: masterSuite.tests.map((masterTest) => {
					const testName = masterTest.name;
					const masterCount = masterTest.count;

					const prTest = prSuite.tests.find(item => item.name == testName);
					if (prTest) {
						const prCount = prTest.count;
						const percent = ((prCount - masterCount) * 100.0) / masterCount;
						const percentage = formatNum(percent, 0, true)

						return {
							name: testName,
							masterCount: formatNum(masterCount),
							prCount: formatNum(prCount),
							diff: formatNum(prCount - masterCount, 0, true),
							percentage,
							badge: `https://img.shields.io/badge/performance-${percentage.replace('-', '--')}%25-${getBadgeColor(percent)}.svg`
						}
					}
				})
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
### Suite: {{name}}

| Test | Master (ops/sec) | PR (ops/sec) | Diff (ops/sec) |
| ------- | ----- | ------- | ------- |
{{#each tests}}
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
