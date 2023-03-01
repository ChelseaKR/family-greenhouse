import http from "../http-common";

class PlantDataService {
    getAll(data) {
        return http.get("/plants", data);
    }

    get(id) {
        return http.get(`/plants/${id}`);
    }

    create(data) {
        return http.post("/plants/add", data);
    }

    update(id, data) {
        return http.put(`/plants/${id}`, data);
    }

    delete(id) {
        return http.delete(`/plants/${id}`);
    }

    deleteAll() {
        return http.delete(`/plants`);
    }

    findByName(userId, name) {
        return http.get(`/plants?userId=${userId}&name=${name}`);
    }

    findByUserId(userId) {
        return http.get(`/plants?userId=${userId}`);
    }
}

export default new PlantDataService();