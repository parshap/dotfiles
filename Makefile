make:
	npm install && \
		node install.js && \
		lesskey

clean:
	git clean -xdf
	git checkout -f
