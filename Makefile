make:
	npm install
	PATH=./node_modules/.bin:$(PATH) jake

clean:
	git clean -xdf
	git checkout -f
