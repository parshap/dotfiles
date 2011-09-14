task("default", [], function() {
	var fs = require("fs"),
		path = require("path"),
		filesPath = path.join(process.cwd(), "files")

	// Creates a symbolic link in $HOME for the file
	function link(file) {
		var source = path.join(filesPath, file),
			dest = path.join(process.env.HOME, file)

		fs.symlink(source, dest, function(err) {
			if (err) throw err
		})
	}

	// Walks all files 
	// dir: The directory to walk
	// callback: A callback passed the file path relative to dir
	function walkFiles(dir, callback) {

		// Walks files in directory relative to dir
		(function walk(relDir) {
			var relDirPath = path.join(dir, relDir)

			fs.readdir(relDirPath, function(err, files) {
				if (err) throw err

				files.forEach(function(file) {
					var filePath = path.join(relDirPath, file),
						fileName = path.join(relDir, file)

					fs.stat(filePath, function(err, stats) {
						if (err) throw err

						if (stats.isDirectory()) {
							walk(fileName)
						}
						else {
							callback(fileName)
						}
					})
				})
			})
		})()
	}

	walkFiles(filesPath, link)
})
