
var request = require('request');

var API_KEY = "bed10ba9e24eeb20";
var WURL = "http://api.wunderground.com/api/" + API_KEY;
var GEO_URL = WURL + "/geolookup/conditions/forecast/pws:0/q/{lat},{lng}.json";

exports.get_weather = function(lat,lng, callback){
	var url = GEO_URL.replace("{lat}",lat).replace("{lng}",lng);
	request(url,callback);
};