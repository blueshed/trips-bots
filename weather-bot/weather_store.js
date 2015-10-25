"use strict";
var Firebase = require('firebase');

/**
	load up the weather
 */
class WeatherStore{
	constructor(fb_path){
		this.fb_path = fb_path;
		this.weather_items = [];
		this.weather_base = new Firebase(fb_path);

		this.weather_base.on('value', function(snapshot){});
		this.weather_base.on("child_added", snapshot => {
			this.weather_items.push({id:snapshot.key(), value:snapshot.val()});
		});
		this.weather_base.on("child_changed", (snapshot)=>{
			var id = snapshot.key();
			this.weather_items.some(function(item){
				if(item.id==id){
					item.value = snapshot.val();
					return true;
				}
			});
		});
		this.weather_base.on("child_removed", snapshot => {
			var id = snapshot.key();
			this.weather_items.some((item,index) => {
				if(item.id==id){
					this.weather_items.splice(index,1);
					return true;
				}
			});
		});
	}

	add(weather){
	    var item = this.weather_items.find(function(item){
	    	return item.value.location == weather.location;
	    });
	    if(!item){
			weather.id = this.weather_base.push(weather).key();
			return weather;
		}
		this.weather_base.child(item.id).update(weather);
		return item;
	}

}


module.exports = WeatherStore;