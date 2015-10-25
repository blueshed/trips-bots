"use strict";
var Firebase = require('firebase');
var request = require('request');

class WeatherWork{

	constructor(fb_path, api_key, weather_store){
		this.fb_path = fb_path;
		this.api_key = api_key;
		this.weather_store = weather_store;

		var wurl = "http://api.wunderground.com/api/" + this.api_key;
		this.geo_url = wurl + "/geolookup/conditions/forecast/pws:0/q/{lat},{lng}.json";

		this.work_base = new Firebase(this.fb_path);
		this.work_base.on('value', function(snapshot){});
		this.work_base.on("child_added", this.check_weather.bind(this));
		this.work_base.on("child_changed", this.check_weather.bind(this));
	}

	check_weather(snapshot){
		var key = snapshot.key();
		var value = snapshot.val();
		if(!value.weather){
			this.get_weather(value.lat, 
							value.lng,
							(error, response, body) => {
							    console.log(response.statusCode) // 200
							    var result = JSON.parse(body);
							    this.update_weather(key, result);
							});
		}
	}

	get_weather(lat,lng, callback){
		var url = this.geo_url.replace("{lat}",lat).replace("{lng}",lng);
		request(url,callback);
	}

	update_weather(work_id, result){
	    var location = result.location.city + " " + result.location.country;
	    var weather = this.weather_store.add({
	    	location: location,
	    	icon: result.current_observation.icon,
	    	temperature: result.current_observation.temperature_string
	    });
	    this.work_base.child(work_id).update({
	    	raw: result,
	    	weather: weather.id
	    });
	}

}

module.exports = WeatherWork; 