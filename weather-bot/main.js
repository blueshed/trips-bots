var weather_store = require('./weather_store');
var work_items = require('./work_items');


var FBPath = "https://popping-inferno-367.firebaseio.com/tests/";
var WEATHER_PATH = FBPath + "weather";
var WORK_PATH = FBPath + "work";

var weather_items = weather_store.init(WEATHER_PATH);
	
work_items.init(WORK_PATH, weather_items);

exports.items = weather_items.items;

