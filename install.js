"use strict";

var path = require("path"),
	fs = require("fs"),
	walkdir = require("walkdir"),
	async = require("async");

var FILES_PATH = path.join(__dirname, "files");

function link(file, callback) {
	var rel = file.slice(FILES_PATH.length + 1),
		dest = path.join(process.env.HOME, rel);

	function doUnlink(callback) {
		fs.unlink(dest, function() {
			callback();
		});
	}

	function doLink(callback) {
		fs.symlink(file, dest, callback);
	}

	console.log("Linking %s to %s", rel, dest);

	async.series([
		doUnlink,
		doLink,
	], callback);
}

var queue = async.queue(link, 1);
var options = {
	no_recurse: true,
};
walkdir(FILES_PATH, options)
	.on("path", function(file) {
		queue.push(file, function(err) {
			if (err) {
				throw err;
			}
		});
	});
