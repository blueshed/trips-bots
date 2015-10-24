
var Firebase = require('firebase');
var weather_bot = require('./weather_bot');


function do_work(fb_path, weather_items){

	var work_base = new Firebase(fb_path);

	function update_weather(work_id, result){
	    var location = result.location.city + " " + result.location.country;
	    var weather = weather_items.add({
	    	location: location,
	    	icon: result.current_observation.icon,
	    	temperature: result.current_observation.temperature_string
	    });
	    work_base.child(work_id).update({
	    	weather: weather.id
	    });
	}

	function check_weather(snapshot){
		var key = snapshot.key();
		var value = snapshot.val();
		if(!value.weather){
			weather_bot.get_weather(value.lat, 
									value.lng,
									function(error, response, body){
									    console.log(response.statusCode) // 200
									    var result = JSON.parse(body);
									    work_base.child(key).update({
									    	raw: result
									    });
									    update_weather(key, result);
									 });
		}
	}

	work_base.on('value', function(snapshot){});
	work_base.on("child_added", check_weather);
	work_base.on("child_changed", check_weather);
}

exports.init = do_work;