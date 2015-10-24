
var Firebase = require('firebase');

/**
	load up the weather
 */
function init(fb_path){
	var weather_items = [];
	var weather_base = new Firebase(fb_path);

	weather_base.on('value', function(snapshot){});
	weather_base.on("child_added", function(snapshot){
		weather_items.push({id:snapshot.key(), value:snapshot.val()});
	});
	weather_base.on("child_changed", function(snapshot){
		var id = snapshot.key();
		weather_items.some(function(item){
			if(item.id==id){
				item.value = snapshot.val();
				return true;
			}
		});
	});
	weather_base.on("child_removed", function(snapshot){
		var id = snapshot.key();
		weather_items.some(function(item,index){
			if(item.id==id){
				weather_items.splice(index,1);
				return true;
			}
		});
	});


	function add(weather){
	    var item = weather_items.find(function(item){
	    	return item.value.location == weather.location;
	    });
	    if(!item){
			weather.id = weather_base.push(weather).key();
			return weather;
		}
		weather_base.child(item.id).update(weather);
		return item;
	}

	return {
		items: weather_items,
		add: add
	};
}


exports.init = init;