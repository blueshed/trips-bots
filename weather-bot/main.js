"use strict";
var WeatherStore = require('./weather_store');
var WeatherWork = require('./weather_work');


class WeatherBot{
	constructor(fb_path, api_key){
		if(!fb_path){
			throw "No firebase path specified!";
		}
		if(!api_key){
			throw "No wunderground api key specified";
		}
		this.fb_path = fb_path;
		this.weather_path = fb_path + "weather";
		this.work_path = fb_path + "work";

		this.weather_store = new WeatherStore(this.weather_path);
		this.work_items = new WeatherWork(this.work_path, api_key, this.weather_store);
	}

	items(){
		return this.weather_store.weather_items;
	}
}

module.exports = WeatherBot;