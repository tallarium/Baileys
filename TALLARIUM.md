# Custom fork instructions
## When making a change
Since we do not release the custom fork as an npm package, the lib folder is not regenerated after a change. As a temporary workaround, we will rebuild and commit the files each time we make a change to the library. This is done with `npm run build:tsc`.
The built files should be commited separately from the actual change.