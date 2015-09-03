// Loads the main gulp library
var gulp = require('gulp');
// Loads the baked.js's tasks
var baked = require('baked/gulp');

var config = baked.init({options:{
  srcDir: "src"
}});

baked.defineTasks(gulp);

// Defaults tasks (you are free to change them)
gulp.task('serve', ['baked:serve']);
gulp.task('default', ['baked:default']);
gulp.task('clean', ['baked:clean']);
