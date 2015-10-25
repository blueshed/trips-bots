"use strict";
var Firebase = require('firebase');

var FBPath = "https://popping-inferno-367.firebaseio.com/tests/";

var work_base = new Firebase(FBPath + "work");

work_base.once('value', function(snapshot){
	work_base.push({
		lat:51.5047283, 
		lng:-0.33914449999997487
	});
});
