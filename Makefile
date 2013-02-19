make:
	npm install && node install.js

clean:
	git clean -xdf
	git checkout -f
